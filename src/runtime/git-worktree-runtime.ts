import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

import type {
  ExecExit,
  ExecHandle,
  ExecSpec,
  ReapOptions,
  ReapReport,
  TeardownOptions,
  WorkerRuntime,
  WorkspaceHandle,
  WorkspaceSpec,
} from './types.ts'

const execFileAsync = promisify(execFile)

// Bounded grace between child exit and forcibly closing its stdio streams.
// Detached grandchildren can inherit the pipes and hold them open forever
// (ADR-0004 §exit-not-close); 2s lets normal buffered output flush.
export const STDIO_DRAIN_GRACE_MS = 2_000

// Bounded wait for a process group to die during teardown before we escalate
// to a group SIGKILL and proceed with worktree removal.
export const TEARDOWN_GROUP_WAIT_MS = 5_000

// Metadata the runtime writes inside each workspace. proc.json is the
// crash-durable process registry (ADR-0004 §orphan safety): an in-memory
// registry dies with the daemon; this file survives SIGKILL/OOM/power-loss
// and lets the reaper recover orphans on the next start.
type WorkspaceMeta = {
  id: string
  taskId: string
  branch: string
  baseRepoPath: string
  createdAt: string
}
type ProcMeta = {
  pid: number
  pgid: number
  // Output of `ps -o lstart= -p <pid>` at spawn time. The reaper compares
  // this before signaling: a matching pid with a different start time is a
  // REUSED pid and must not be killed.
  startTime: string
}

// Env for the runtime's own git invocations. Scrubbed-but-functional: hooks
// are already disabled per-command via -c core.hooksPath=/dev/null (ADR-0004
// §security — worktree add executes repo-configured hooks otherwise); this
// env additionally keeps daemon secrets away from git's own process tree
// while preserving what fetch/worktree genuinely need (PATH, HOME for
// .gitconfig + credential helpers, SSH agent for ssh remotes).
function gitEnv(): Record<string, string> {
  const out: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' }
  for (const k of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SSH_AUTH_SOCK'] as const) {
    const v = process.env[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', ...args],
    { cwd, env: gitEnv(), maxBuffer: 10 * 1024 * 1024 },
  )
  return stdout
}

// `ps -o lstart= -p <pid>` — empty string when the pid does not exist.
async function processStartTime(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)])
    return stdout.trim()
  } catch {
    return ''
  }
}

function trySignal(target: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(target, sig)
    return true
  } catch {
    return false
  }
}

function groupAlive(pgid: number): boolean {
  return trySignal(-pgid, 0)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export type GitWorktreeRuntimeOptions = {
  // Where workspaces live. Defaults to ~/.vibe-manager/workspaces.
  root?: string
}

export class GitWorktreeRuntime implements WorkerRuntime {
  readonly #root: string
  // Per-baseRepo serialization: concurrent `git worktree add` against one
  // repo contends on .git lockfiles and fails spuriously. In-process only —
  // the cross-process guard is the CLI's daemon pidfile.
  readonly #repoLocks = new Map<string, Promise<unknown>>()
  // Live handles for daemon-shutdown signal handlers (layer 1 of orphan
  // safety; proc.json is layer 2, the reaper layer 3).
  readonly #live = new Set<ExecHandle>()
  #shutdownInstalled = false

  constructor(opts: GitWorktreeRuntimeOptions = {}) {
    this.#root = opts.root ?? join(os.homedir(), '.vibe-manager', 'workspaces')
  }

  // Serialize fn against all other git operations touching baseRepoPath.
  #withRepoLock<T>(baseRepoPath: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#repoLocks.get(baseRepoPath) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.#repoLocks.set(baseRepoPath, next.catch(() => {}))
    return next
  }

  #installShutdownHandlers(): void {
    if (this.#shutdownInstalled) return
    this.#shutdownInstalled = true
    const killAll = () => {
      for (const h of this.#live) h.signal('SIGKILL', { group: true })
    }
    process.once('SIGINT', killAll)
    process.once('SIGTERM', killAll)
  }

  async createWorkspace(spec: WorkspaceSpec): Promise<WorkspaceHandle> {
    if (!spec.baseRef) throw new Error('WorkspaceSpec.baseRef is required — never implicit HEAD')
    const id = `${spec.taskId}-a${spec.attempt}`
    const branch = `vibe/${id}`
    const dir = join(this.#root, id)

    return this.#withRepoLock(spec.baseRepoPath, async () => {
      if (!existsSync(join(spec.baseRepoPath, '.git'))) {
        throw new Error(`base repo not found or not a git repo: ${spec.baseRepoPath}`)
      }
      // Refresh the remote ref when baseRef points at one. Fetch failure is
      // loud (DX registry row), not swallowed — a stale base silently
      // producing wrong-parent branches is worse than a failed task.
      const remote = spec.baseRef.includes('/') ? spec.baseRef.split('/')[0] : null
      if (remote) {
        const remotes = (await git(['remote'], spec.baseRepoPath)).split('\n').filter(Boolean)
        if (remotes.includes(remote!)) {
          await git(['fetch', '--quiet', remote!], spec.baseRepoPath).catch((err) => {
            throw new Error(`git fetch ${remote} failed for ${spec.baseRepoPath}: ${(err as Error).message}`)
          })
        }
      }
      // Existing branch = hard error with a distinct reason — silent reuse
      // would graft a retry onto a stale attempt's history.
      const existing = await git(['branch', '--list', branch], spec.baseRepoPath)
      if (existing.trim() !== '') {
        throw new Error(
          `branch ${branch} already exists in ${spec.baseRepoPath} — leftover from a previous attempt; reap or remove it first`,
        )
      }
      await mkdir(this.#root, { recursive: true })
      if (existsSync(dir)) {
        throw new Error(`workspace directory already exists: ${dir} — reap leftovers first`)
      }
      await git(['worktree', 'add', '-b', branch, dir, spec.baseRef], spec.baseRepoPath)
      const meta: WorkspaceMeta = {
        id,
        taskId: spec.taskId,
        branch,
        baseRepoPath: spec.baseRepoPath,
        createdAt: new Date().toISOString(),
      }
      await mkdir(join(dir, '.vibe'), { recursive: true })
      await writeFile(join(dir, '.vibe', 'workspace.json'), JSON.stringify(meta, null, 2))
      return { id, path: dir, branch }
    })
  }

  async exec(ws: WorkspaceHandle, spec: ExecSpec): Promise<ExecHandle> {
    this.#installShutdownHandlers()
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd ?? ws.path,
      // VERBATIM — never merged with process.env, never logged (ADR-0004).
      env: spec.env,
      // detached: true puts the child in its own process group so stop() can
      // group-kill grandchildren (#15). Orphan safety moves to proc.json +
      // reaper + shutdown handlers — see ADR-0004 §orphan safety.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    // Buffer stdio through PassThroughs attached SYNCHRONOUSLY at spawn: a
    // fast-exiting child's 'close' can fire before exec() returns (we await
    // `ps` below for proc.json), and unconsumed pipe data is dropped at close
    // on modern Node. Piping starts consumption now; the handle's consumer
    // reads from the PassThroughs whenever it attaches.
    const stdoutPT = new PassThrough()
    const stderrPT = new PassThrough()
    child.stdout!.pipe(stdoutPT)
    child.stderr!.pipe(stderrPT)

    let settled = false
    const exitP = new Promise<ExecExit>((resolve, reject) => {
      child.once('error', (err) => {
        if (!settled) {
          settled = true
          reject(err)
        }
      })
      child.once('exit', (code, signal) => {
        if (settled) return
        settled = true
        // wait() resolves only after the consumer-visible streams have fully
        // drained (so accumulated stdout is complete at resolution time) OR
        // the bounded grace expires (a grandchild holding the pipe, or no
        // consumer ever attaching, must not block wait() forever).
        const ptEnded = (pt: PassThrough) =>
          pt.readableEnded ? Promise.resolve() : new Promise<void>((r) => pt.once('end', () => r()))
        const drained = Promise.all([ptEnded(stdoutPT), ptEnded(stderrPT)]).then(
          () => 'drained' as const,
        )
        void Promise.race([drained, sleep(STDIO_DRAIN_GRACE_MS).then(() => 'timeout' as const)])
          .then((winner) => {
            if (winner === 'timeout') {
              child.stdout?.destroy()
              child.stderr?.destroy()
              stdoutPT.destroy()
              stderrPT.destroy()
              // Stragglers holding the pipe die with the group.
              if (pgid != null) trySignal(-pgid, 'SIGKILL')
            }
            resolve({ exitCode: code, signal: signal ?? null })
          })
      })
    })

    // detached spawn → the child is a new session/group leader: pgid == pid.
    const pgid = child.pid ?? null

    const handle: ExecHandle = {
      pid: child.pid ?? null,
      pgid,
      stdout: stdoutPT,
      stderr: stderrPT,
      wait: () => exitP,
      signal: (sig, opts) => {
        const target = opts?.group && pgid != null ? -pgid : child.pid
        if (target == null) return false
        return trySignal(target, sig)
      },
    }

    this.#live.add(handle)
    void exitP.then(() => this.#live.delete(handle)).catch(() => this.#live.delete(handle))

    // Crash-durable registry entry. Managed workspaces only — 'unmanaged:*'
    // handles (worker run without a provisioned workspace) get no .vibe dir.
    if (child.pid != null && !ws.id.startsWith('unmanaged:')) {
      const startTime = await processStartTime(child.pid)
      const proc: ProcMeta = { pid: child.pid, pgid: pgid!, startTime }
      await mkdir(join(ws.path, '.vibe'), { recursive: true }).catch(() => {})
      await writeFile(join(ws.path, '.vibe', 'proc.json'), JSON.stringify(proc)).catch(() => {})
    }

    return handle
  }

  async teardown(ws: WorkspaceHandle, opts: TeardownOptions = {}): Promise<void> {
    // Make sure nothing is still writing into the directory before removal.
    // Same pid-identity validation as the reaper: a recorded pid whose start
    // time no longer matches is a REUSED pid and must never be signaled or
    // waited on (the wait would block on an innocent process).
    const proc = await this.#readProc(ws.path)
    if (proc && (await this.#verifyRecordedProcess(proc)) === 'alive') {
      const deadline = Date.now() + TEARDOWN_GROUP_WAIT_MS
      while (groupAlive(proc.pgid) && Date.now() < deadline) await sleep(100)
      if (groupAlive(proc.pgid)) {
        trySignal(-proc.pgid, 'SIGKILL')
        await sleep(200)
      }
    }
    if (opts.preserve) {
      await writeFile(join(ws.path, '.vibe', 'preserved'), new Date().toISOString()).catch(() => {})
      return
    }
    const meta = await this.#readMeta(ws.path)
    const baseRepo = meta?.baseRepoPath
    if (baseRepo && existsSync(join(baseRepo, '.git'))) {
      await this.#withRepoLock(baseRepo, async () => {
        // --force: a dirty worktree is the NORMAL post-task state, not an
        // edge. Removal precedes branch -D (a branch checked out in a
        // worktree cannot be deleted).
        await git(['worktree', 'remove', '--force', ws.path], baseRepo)
        await git(['branch', '-D', ws.branch], baseRepo)
      })
    } else {
      // Base repo gone — fall back to filesystem removal so reap can still
      // clean the root; `git worktree prune` in reap() clears stale metadata.
      await rm(ws.path, { recursive: true, force: true })
    }
  }

  async listWorkspaces(): Promise<WorkspaceHandle[]> {
    if (!existsSync(this.#root)) return []
    const out: WorkspaceHandle[] = []
    for (const entry of await readdir(this.#root)) {
      const meta = await this.#readMeta(join(this.#root, entry))
      if (meta) out.push({ id: meta.id, path: join(this.#root, entry), branch: meta.branch })
    }
    return out
  }

  // Crash recovery (ADR-0004 §orphan safety, layer 3). For every workspace on
  // disk: validate the recorded pid by start-time (NEVER kill a reused pid),
  // group-kill survivors, tear the workspace down, prune stale git metadata.
  async reap(opts: ReapOptions = {}): Promise<ReapReport[]> {
    const reports: ReapReport[] = []
    const baseRepos = new Set<string>()
    for (const ws of await this.listWorkspaces()) {
      const meta = await this.#readMeta(ws.path)
      const preserved = existsSync(join(ws.path, '.vibe', 'preserved'))
      if (preserved && !opts.includePreserved) {
        reports.push({
          workspaceId: ws.id,
          taskId: meta?.taskId ?? null,
          path: ws.path,
          process: 'none-recorded',
          removed: false,
          preservedSkipped: true,
        })
        continue
      }
      let processOutcome: ReapReport['process'] = 'none-recorded'
      const proc = await this.#readProc(ws.path)
      if (proc) {
        const verdict = await this.#verifyRecordedProcess(proc)
        if (verdict === 'dead') {
          processOutcome = 'already-dead'
        } else if (verdict === 'reused') {
          // Same pid, different birth — the OS recycled it. Do not signal.
          processOutcome = 'pid-reused-not-touched'
        } else {
          trySignal(-proc.pgid, 'SIGKILL')
          const deadline = Date.now() + TEARDOWN_GROUP_WAIT_MS
          while (groupAlive(proc.pgid) && Date.now() < deadline) await sleep(100)
          processOutcome = 'killed'
        }
      }
      if (meta?.baseRepoPath) baseRepos.add(meta.baseRepoPath)
      await this.teardown(ws)
      reports.push({
        workspaceId: ws.id,
        taskId: meta?.taskId ?? null,
        path: ws.path,
        process: processOutcome,
        removed: true,
        preservedSkipped: false,
      })
    }
    for (const repo of baseRepos) {
      if (existsSync(join(repo, '.git'))) {
        await this.#withRepoLock(repo, () => git(['worktree', 'prune'], repo)).catch(() => {})
      }
    }
    return reports
  }

  // Pid-identity check shared by teardown and reap: 'alive' only when the
  // recorded pid exists AND its start time matches what we recorded at spawn.
  async #verifyRecordedProcess(proc: ProcMeta): Promise<'alive' | 'dead' | 'reused'> {
    const currentStart = await processStartTime(proc.pid)
    if (currentStart === '') return 'dead'
    if (proc.startTime !== '' && currentStart !== proc.startTime) return 'reused'
    return 'alive'
  }

  async #readMeta(wsPath: string): Promise<WorkspaceMeta | null> {
    try {
      return JSON.parse(await readFile(join(wsPath, '.vibe', 'workspace.json'), 'utf8')) as WorkspaceMeta
    } catch {
      return null
    }
  }

  async #readProc(wsPath: string): Promise<ProcMeta | null> {
    try {
      return JSON.parse(await readFile(join(wsPath, '.vibe', 'proc.json'), 'utf8')) as ProcMeta
    } catch {
      return null
    }
  }
}
