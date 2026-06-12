import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

import { GitWorktreeRuntime, STDIO_DRAIN_GRACE_MS } from '../../src/runtime/git-worktree-runtime.ts'
import type { WorkspaceHandle } from '../../src/runtime/types.ts'

const execFileAsync = promisify(execFile)

// These tests use REAL git repos (in tmp dirs, no network) and REAL processes.
// They are the load-bearing safety tests for ADR-0004's GitWorktreeRuntime:
// crash-orphan recovery, pid-reuse protection, dirty teardown, env isolation.

let fixtureRepo: string
let wsRoot: string
let runtime: GitWorktreeRuntime

async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd })
  return stdout
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(cond: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

before(async () => {
  fixtureRepo = await mkdtemp(join(os.tmpdir(), 'vibe-fixture-'))
  await gitIn(fixtureRepo, 'init', '-b', 'main')
  await gitIn(fixtureRepo, 'config', 'user.email', 'test@vibe-manager.test')
  await gitIn(fixtureRepo, 'config', 'user.name', 'Vibe Test')
  await writeFile(join(fixtureRepo, 'README.md'), '# fixture\n')
  await gitIn(fixtureRepo, 'add', '.')
  await gitIn(fixtureRepo, 'commit', '-m', 'init')
  wsRoot = await mkdtemp(join(os.tmpdir(), 'vibe-ws-'))
  runtime = new GitWorktreeRuntime({ root: wsRoot })
})

after(async () => {
  await rm(fixtureRepo, { recursive: true, force: true })
  await rm(wsRoot, { recursive: true, force: true })
})

function spec(taskId: string, attempt = 0) {
  return { taskId, baseRepoPath: fixtureRepo, baseRef: 'main', attempt }
}

describe('GitWorktreeRuntime — workspace lifecycle', () => {
  it('createWorkspace: worktree on baseRef with retry-safe branch name + workspace.json', async () => {
    const ws = await runtime.createWorkspace(spec('task-roundtrip'))
    assert.equal(ws.branch, 'vibe/task-roundtrip-a0')
    assert.ok(existsSync(join(ws.path, 'README.md')), 'worktree must materialize baseRef content')
    const meta = JSON.parse(await readFile(join(ws.path, '.vibe', 'workspace.json'), 'utf8'))
    assert.equal(meta.taskId, 'task-roundtrip')
    assert.equal(meta.baseRepoPath, fixtureRepo)
    const head = (await gitIn(ws.path, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()
    assert.equal(head, 'vibe/task-roundtrip-a0')
    // Runtime metadata must be invisible to git — a worker's `git add -A`
    // swept .vibe/ into a PR once (smoke run #56).
    const status = await gitIn(ws.path, 'status', '--porcelain')
    assert.ok(!status.includes('.vibe'), `.vibe/ must be excluded from git status, got: ${status}`)
    await runtime.teardown(ws)
  })

  it('createWorkspace: rejects missing baseRef (never implicit HEAD)', async () => {
    await assert.rejects(
      () => runtime.createWorkspace({ taskId: 't', baseRepoPath: fixtureRepo, baseRef: '', attempt: 0 }),
      /baseRef is required/,
    )
  })

  it('createWorkspace: existing branch is a hard error, never silent reuse (eng F9)', async () => {
    const ws = await runtime.createWorkspace(spec('task-collide'))
    // Preserve so the branch survives teardown — models a failed task kept
    // for post-mortem, then a retry with the SAME attempt number (a bug).
    await runtime.teardown(ws, { preserve: true })
    await assert.rejects(() => runtime.createWorkspace(spec('task-collide')), /already exists/)
    // The retry path with a bumped attempt number works.
    const ws2 = await runtime.createWorkspace(spec('task-collide', 1))
    assert.equal(ws2.branch, 'vibe/task-collide-a1')
    await runtime.teardown(ws2)
    await runtime.reap({ includePreserved: true })
  })

  it('teardown removes a DIRTY worktree and its branch (the normal post-task state, eng F8)', async () => {
    const ws = await runtime.createWorkspace(spec('task-dirty'))
    await writeFile(join(ws.path, 'junk.txt'), 'uncommitted')
    await writeFile(join(ws.path, 'README.md'), 'modified tracked file')
    await runtime.teardown(ws)
    assert.ok(!existsSync(ws.path), 'dirty worktree directory must be removed (--force path)')
    const branches = await gitIn(fixtureRepo, 'branch', '--list', ws.branch)
    assert.equal(branches.trim(), '', 'task branch must be deleted after worktree removal')
  })

  it('teardown(preserve) keeps the workspace with a marker; reap skips it; --include-preserved removes it (eng F13, DX F17)', async () => {
    const ws = await runtime.createWorkspace(spec('task-preserve'))
    await runtime.teardown(ws, { preserve: true })
    assert.ok(existsSync(join(ws.path, '.vibe', 'preserved')), 'preserved marker must exist')
    const reports = await runtime.reap()
    const mine = reports.find((r) => r.workspaceId === ws.id)
    assert.ok(mine)
    assert.equal(mine.preservedSkipped, true, 'reap must skip preserved workspaces by default')
    assert.ok(existsSync(ws.path), 'preserved workspace must survive a default reap')
    const reports2 = await runtime.reap({ includePreserved: true })
    const mine2 = reports2.find((r) => r.workspaceId === ws.id)
    assert.ok(mine2)
    assert.equal(mine2.removed, true)
    assert.ok(!existsSync(ws.path))
  })
})

describe('GitWorktreeRuntime — exec + process groups', () => {
  it('env is passed VERBATIM — child env equals exactly ExecSpec.env (eng F14)', async () => {
    const ws = await runtime.createWorkspace(spec('task-env'))
    try {
      const h = await runtime.exec(ws, {
        command: '/usr/bin/env',
        args: [],
        env: { VIBE_TEST_ONLY: 'yes' },
      })
      let out = ''
      h.stdout.on('data', (c: Buffer) => { out += String(c) })
      const exit = await h.wait()
      assert.equal(exit.exitCode, 0)
      // __CF_USER_TEXT_ENCODING is injected by the macOS kernel/libc into
      // every spawned process — it never came from process.env and is not a
      // leak. Everything else must be exactly ExecSpec.env.
      const lines = out
        .split('\n')
        .filter(Boolean)
        .filter((l) => !l.startsWith('__CF_USER_TEXT_ENCODING='))
        .sort()
      assert.deepEqual(
        lines,
        ['VIBE_TEST_ONLY=yes'],
        `child env must be exactly ExecSpec.env — got: ${lines.join(', ')}`,
      )
    } finally {
      await runtime.teardown(ws)
    }
  })

  it('group SIGKILL kills grandchildren too (the #15 leak)', async () => {
    const ws = await runtime.createWorkspace(spec('task-group'))
    try {
      // sh spawns a backgrounded sleep (the grandchild), writes its pid, then
      // sleeps itself. SIGKILLing only the sh leader would leak the sleep.
      const pidFile = join(ws.path, 'grandchild.pid')
      const h = await runtime.exec(ws, {
        command: '/bin/sh',
        args: ['-c', `sleep 300 & echo $! > ${JSON.stringify(pidFile)}; sleep 300`],
        env: { PATH: process.env.PATH! },
      })
      await waitUntil(() => existsSync(pidFile), 5_000, 'grandchild pid file')
      const grandchild = Number((await readFile(pidFile, 'utf8')).trim())
      assert.ok(alive(grandchild), 'grandchild should be running')
      assert.ok(h.signal('SIGKILL', { group: true }), 'group signal should land')
      await h.wait()
      await waitUntil(() => !alive(grandchild), 5_000, 'grandchild death by group kill')
      assert.ok(!alive(grandchild), 'group SIGKILL must take the grandchild down with the leader')
    } finally {
      await runtime.teardown(ws)
    }
  })

  it('wait() resolves on EXIT within the drain grace even when a grandchild holds stdout open (eng F7)', async () => {
    const ws = await runtime.createWorkspace(spec('task-stdout-hold'))
    try {
      // The backgrounded sleep inherits the stdout pipe; the leader exits
      // immediately. A close-based wait would hang ~300s; exit-based wait
      // with bounded drain must resolve in ~STDIO_DRAIN_GRACE_MS.
      const h = await runtime.exec(ws, {
        command: '/bin/sh',
        args: ['-c', 'echo started; sleep 300 & exit 0'],
        env: { PATH: process.env.PATH! },
      })
      const t0 = Date.now()
      const exit = await h.wait()
      const elapsed = Date.now() - t0
      assert.equal(exit.exitCode, 0)
      assert.ok(
        elapsed < STDIO_DRAIN_GRACE_MS + 2_000,
        `wait() must resolve within the drain grace, took ${elapsed}ms`,
      )
    } finally {
      await runtime.teardown(ws)
    }
  })

  it('spawn failure (ENOENT) rejects wait() — typed channel, no hang (eng F10)', async () => {
    const ws = await runtime.createWorkspace(spec('task-enoent'))
    try {
      const h = await runtime.exec(ws, {
        command: '/definitely/not/a/real/binary-xyz',
        args: [],
        env: {},
      })
      await assert.rejects(() => h.wait(), /ENOENT/)
    } finally {
      await runtime.teardown(ws)
    }
  })

  it('proc.json is written at spawn with pid/pgid/startTime (crash-durable registry, eng F2)', async () => {
    const ws = await runtime.createWorkspace(spec('task-procjson'))
    try {
      const h = await runtime.exec(ws, {
        command: '/bin/sleep',
        args: ['300'],
        env: {},
      })
      const proc = JSON.parse(await readFile(join(ws.path, '.vibe', 'proc.json'), 'utf8'))
      assert.equal(proc.pid, h.pid)
      assert.equal(proc.pgid, h.pgid)
      assert.ok(proc.startTime.length > 0, 'startTime must be recorded for pid-reuse validation')
      h.signal('SIGKILL', { group: true })
      await h.wait()
    } finally {
      await runtime.teardown(ws)
    }
  })
})

describe('GitWorktreeRuntime — reaper (crash recovery)', () => {
  it('daemon-loss simulation: a fresh runtime instance reaps the orphan group and the worktree (eng F2)', async () => {
    const ws = await runtime.createWorkspace(spec('task-orphan'))
    const pidFile = join(ws.path, 'orphan-grandchild.pid')
    const h = await runtime.exec(ws, {
      command: '/bin/sh',
      args: ['-c', `sleep 300 & echo $! > ${JSON.stringify(pidFile)}; sleep 300`],
      env: { PATH: process.env.PATH! },
    })
    await waitUntil(() => existsSync(pidFile), 5_000, 'orphan grandchild pid file')
    const leader = h.pid!
    const grandchild = Number((await readFile(pidFile, 'utf8')).trim())
    assert.ok(alive(leader) && alive(grandchild), 'orphan group should be running')

    // "Lose" the daemon: a brand-new runtime instance has no in-memory state.
    // Only proc.json connects it to the orphan.
    const recovered = new GitWorktreeRuntime({ root: wsRoot })
    const reports = await recovered.reap()
    const mine = reports.find((r) => r.workspaceId === ws.id)
    assert.ok(mine, 'reaper must find the orphaned workspace')
    assert.equal(mine.process, 'killed')
    assert.equal(mine.removed, true)
    await waitUntil(() => !alive(leader) && !alive(grandchild), 5_000, 'orphan group death')
    assert.ok(!existsSync(ws.path), 'orphaned worktree must be removed')
    const branches = await gitIn(fixtureRepo, 'branch', '--list', ws.branch)
    assert.equal(branches.trim(), '', 'orphaned branch must be deleted')
  })

  it('pid-reuse protection: a recorded pid with a different start time is NOT killed (eng F2)', async () => {
    const ws = await runtime.createWorkspace(spec('task-pidreuse'))
    // An innocent process that happens to wear the recorded pid today.
    const innocent = spawn('/bin/sleep', ['300'], { detached: true, stdio: 'ignore' })
    await new Promise<void>((r) => innocent.once('spawn', () => r()))
    try {
      await mkdir(join(ws.path, '.vibe'), { recursive: true })
      await writeFile(
        join(ws.path, '.vibe', 'proc.json'),
        JSON.stringify({
          pid: innocent.pid,
          pgid: innocent.pid,
          // A start time that cannot match the live process — models the OS
          // having recycled the pid since the daemon crashed.
          startTime: 'Thu Jan  1 00:00:00 1970',
        }),
      )
      const reports = await runtime.reap()
      const mine = reports.find((r) => r.workspaceId === ws.id)
      assert.ok(mine)
      assert.equal(mine.process, 'pid-reused-not-touched', 'reaper must refuse to signal a reused pid')
      assert.ok(alive(innocent.pid!), 'the innocent process must survive the reap')
      assert.equal(mine.removed, true, 'the stale workspace is still cleaned up')
    } finally {
      try { process.kill(-innocent.pid!, 'SIGKILL') } catch { /* already gone */ }
    }
  })

  it('reap with no proc.json records none-recorded and still removes the workspace', async () => {
    const ws = await runtime.createWorkspace(spec('task-noproc'))
    const reports = await runtime.reap()
    const mine = reports.find((r) => r.workspaceId === ws.id)
    assert.ok(mine)
    assert.equal(mine.process, 'none-recorded')
    assert.equal(mine.removed, true)
  })
})
