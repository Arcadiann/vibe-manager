import { beforeEach, afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import {
  ClaudeCodeWorker,
  HEARTBEAT_INTERVAL_MS,
  MISSING_API_KEY_MESSAGE,
  STOP_GRACE_MS,
  buildSpawnEnv,
  buildExecSpec,
  resolveApiKey,
  unmanagedWorkspace,
} from '../../src/workers/claude-code-worker.ts'
import type { TaskSpec, WorkerContext, WorkerEvent } from '../../src/workers/types.ts'
import type { ExecExit, ExecHandle, WorkerRuntime } from '../../src/runtime/types.ts'
import { GitWorktreeRuntime } from '../../src/runtime/git-worktree-runtime.ts'

// ADR-0004 seam: the worker is constructed with a WorkerRuntime and calls
// runtime.exec() — tests inject a fake runtime returning fake ExecHandles.
// Same testing pattern the pre-ADR-0004 worker used for SpawnFn, one level up.

// Minimal fake ExecHandle: stdout/stderr as Readables that emit the provided
// strings then end; wait() resolves on a double-setImmediate so the worker's
// 'data' handlers have drained the streams first (mirrors the runtime's
// drain-before-resolve contract).
function fakeHandle(opts: {
  stdout?: string
  stderr?: string
  exitCode: number
  signal?: string | null
}): ExecHandle {
  return {
    pid: 12345,
    pgid: 12345,
    stdout: Readable.from([opts.stdout ?? '']),
    stderr: Readable.from([opts.stderr ?? '']),
    wait: () =>
      new Promise<ExecExit>((resolve) => {
        setImmediate(() => {
          setImmediate(() => resolve({ exitCode: opts.exitCode, signal: opts.signal ?? null }))
        })
      }),
    signal: () => true,
  }
}

function fakeRuntime(handle: ExecHandle | (() => ExecHandle)): WorkerRuntime {
  return {
    createWorkspace: () => Promise.reject(new Error('not under test')),
    exec: async () => (typeof handle === 'function' ? handle() : handle),
    teardown: async () => {},
    listWorkspaces: async () => [],
  }
}

function workerWith(handle: ExecHandle | (() => ExecHandle)): ClaudeCodeWorker {
  return new ClaudeCodeWorker({ runtime: fakeRuntime(handle) })
}

async function drainTerminal(worker: ClaudeCodeWorker, handle: string): Promise<WorkerEvent> {
  for await (const ev of worker.stream(handle)) {
    if (ev.kind === 'complete' || ev.kind === 'failed') return ev
  }
  throw new Error('stream ended without terminal event')
}

function makeSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    taskId: 'test-task',
    title: 'Test',
    description: 'respond with the literal string OK and nothing else',
    successCriteria: null,
    maxTokens: null,
    timeoutMs: 60_000,
    workingDirectory: null,
    ...overrides,
  }
}

describe('ClaudeCodeWorker — env injection (CI)', () => {
  it('throws at construction when ANTHROPIC_API_KEY is missing', () => {
    const saved = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    try {
      assert.throws(() => workerWith(fakeHandle({ exitCode: 0 })), (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /ANTHROPIC_API_KEY/)
        assert.equal(err.message, MISSING_API_KEY_MESSAGE)
        return true
      })
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
    }
  })

  it('throws at construction when ANTHROPIC_API_KEY is empty string', () => {
    const saved = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = ''
    try {
      assert.throws(() => workerWith(fakeHandle({ exitCode: 0 })), /ANTHROPIC_API_KEY/)
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
      else delete process.env.ANTHROPIC_API_KEY
    }
  })

  it('exec spec always includes --bare (regression guard for ADR-0002)', () => {
    const spec = buildExecSpec(makeSpec(), 'sk-ant-fake-test-key')
    assert.equal(spec.command, 'claude')
    assert.ok(spec.args.includes('--bare'), `expected --bare in args: ${spec.args.join(' ')}`)
    assert.ok(spec.args.includes('-p'), '`-p` (print) flag required for non-interactive use')
    const fmtIdx = spec.args.indexOf('--output-format')
    assert.notEqual(fmtIdx, -1, '--output-format required for structured parsing')
    assert.equal(spec.args[fmtIdx + 1], 'json')
  })

  it('exec spec injects ANTHROPIC_API_KEY into env', () => {
    const spec = buildExecSpec(makeSpec(), 'sk-ant-fake-test-key')
    assert.equal(spec.env.ANTHROPIC_API_KEY, 'sk-ant-fake-test-key')
  })

  it('exec spec does NOT write any credential file path into args', () => {
    const spec = buildExecSpec(makeSpec(), 'sk-ant-fake-test-key')
    const joined = spec.args.join(' ')
    assert.doesNotMatch(joined, /credentials\.json/)
    assert.doesNotMatch(joined, /\.claude\//)
  })

  it('exec env contains exactly the allowlist keys plus ANTHROPIC_API_KEY, no others (closes #8)', () => {
    // Pollute process.env with a known-bad set covering every category from
    // issue #8: endpoint redirect, provider switch, model override, alt-auth,
    // OAuth side-channel, 3P provider creds, NODE_OPTIONS, HTTP_PROXY,
    // publish credentials (dispatcher-only per ADR-0004 / plan §4b-8), plus
    // an arbitrary leak canary. None of these may appear in the exec env.
    const polluted = {
      FAKE_LEAK_VAR: 'leak',
      ANTHROPIC_BASE_URL: 'https://evil.example/',
      ANTHROPIC_MODEL: 'claude-haiku-cheap',
      ANTHROPIC_AUTH_TOKEN: 'bearer-attacker',
      ANTHROPIC_CUSTOM_HEADERS: 'X-Evil: 1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
      CLAUDE_CODE_USE_ANTHROPIC_AWS: '1',
      CLAUDE_CODE_API_BASE_URL: 'https://evil.example/v1',
      CLAUDE_CODE_OAUTH_TOKEN: 'old-style-oauth',
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'refresh',
      CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'session',
      AWS_BEARER_TOKEN_BEDROCK: 'aws-bearer',
      GH_TOKEN: 'gh-publish-cred',
      GITHUB_TOKEN: 'gh-publish-cred-2',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      NODE_OPTIONS: '--inspect=0.0.0.0:9229',
      HTTP_PROXY: 'http://attacker.example:8080',
      HTTPS_PROXY: 'http://attacker.example:8080',
      NO_PROXY: 'localhost',
    }
    const saved: Record<string, string | undefined> = {}
    for (const k of Object.keys(polluted)) {
      saved[k] = process.env[k]
      process.env[k] = polluted[k as keyof typeof polluted]
    }
    try {
      const env = buildSpawnEnv('sk-ant-fake-test-key')
      for (const k of Object.keys(polluted)) {
        assert.equal(
          env[k],
          undefined,
          `${k} leaked into exec env — allowlist breach`,
        )
      }
      assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-fake-test-key')
      const allowed = new Set([
        'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
        'LANG', 'LC_ALL', 'TMPDIR', 'TZ',
        'ANTHROPIC_API_KEY',
      ])
      for (const k of Object.keys(env)) {
        assert.ok(
          allowed.has(k),
          `unexpected key in exec env: ${k} (not in allowlist)`,
        )
      }
    } finally {
      for (const k of Object.keys(polluted)) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  })

  it('exec env passes through allowlist keys when defined in process.env', () => {
    const saved = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
    }
    process.env.PATH = '/usr/bin:/bin'
    process.env.HOME = '/tmp/fakehome'
    process.env.USER = 'fakeuser'
    try {
      const env = buildSpawnEnv('sk-ant-fake-test-key')
      assert.equal(env.PATH, '/usr/bin:/bin')
      assert.equal(env.HOME, '/tmp/fakehome')
      assert.equal(env.USER, 'fakeuser')
    } finally {
      for (const k of Object.keys(saved) as Array<keyof typeof saved>) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  })

  it('exec env omits allowlist keys that are absent from process.env (no empty-string padding)', () => {
    const saved = process.env.TZ
    delete process.env.TZ
    try {
      const env = buildSpawnEnv('sk-ant-fake-test-key')
      assert.ok(
        !('TZ' in env),
        'TZ must be omitted entirely, not set to "" — empty string changes child behavior',
      )
    } finally {
      if (saved !== undefined) process.env.TZ = saved
    }
  })

  // The pre-ADR-0004 "does NOT detach" orphan-prevention test moved to the
  // runtime suite: detachment is now the runtime's job, and its orphan-safety
  // contract (proc.json + start-time-validated reaper) is tested there.
  it('exec spec carries no placement detail (cwd only when workingDirectory set)', () => {
    const bare = buildExecSpec(makeSpec(), 'sk-ant-fake-test-key')
    assert.ok(!('cwd' in bare), 'cwd must be absent when workingDirectory is null — runtime supplies the workspace path')
    const dir = buildExecSpec(makeSpec({ workingDirectory: '/tmp/ws' }), 'sk-ant-fake-test-key')
    assert.equal(dir.cwd, '/tmp/ws')
  })

  it('unmanagedWorkspace is honestly marked (never reapable)', () => {
    const ws = unmanagedWorkspace(makeSpec({ workingDirectory: '/tmp/somewhere' }))
    assert.ok(ws.id.startsWith('unmanaged:'))
    assert.equal(ws.path, '/tmp/somewhere')
  })

  it('resolveApiKey: WorkerContext.env override wins when non-empty', () => {
    const ctx: WorkerContext = { env: { ANTHROPIC_API_KEY: 'sk-ant-override' } }
    assert.equal(resolveApiKey(ctx, 'sk-ant-fallback'), 'sk-ant-override')
  })

  it('resolveApiKey: empty / missing context override falls back to constructor key', () => {
    assert.equal(resolveApiKey({ env: {} }, 'sk-ant-fallback'), 'sk-ant-fallback')
    assert.equal(
      resolveApiKey({ env: { ANTHROPIC_API_KEY: '' } }, 'sk-ant-fallback'),
      'sk-ant-fallback',
      'empty string must not be treated as a deliberate credential scrub',
    )
    assert.equal(resolveApiKey(null, 'sk-ant-fallback'), 'sk-ant-fallback')
    assert.equal(resolveApiKey(undefined, 'sk-ant-fallback'), 'sk-ant-fallback')
  })
})

describe('ClaudeCodeWorker — terminal-event mapping (CI, closes #17)', () => {
  // The seam is the constructor-injected fake runtime; every test builds a
  // fake handle that emits the stdout/exit-code shape under test, then drains
  // the stream for the terminal event.
  const ctx: WorkerContext = { env: { ANTHROPIC_API_KEY: 'sk-ant-fake-test-key' } }
  const SAVED_KEY = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-test-key'

  it('exit 0 + parses + is_error: false → complete with result payload', async () => {
    const envelope = { type: 'result', subtype: 'success', is_error: false, result: 'OK' }
    const worker = workerWith(fakeHandle({ stdout: JSON.stringify(envelope), exitCode: 0 }))
    const handle = await worker.start(makeSpec(), ctx)
    const ev = await drainTerminal(worker, handle)
    assert.equal(ev.kind, 'complete')
    assert.equal((ev as Extract<WorkerEvent, { kind: 'complete' }>).partial, false)
    assert.deepEqual((ev as Extract<WorkerEvent, { kind: 'complete' }>).result, envelope)
  })

  it('exit 0 + parses + is_error: true + error text → failed with reason from result', async () => {
    const envelope = {
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      result: 'Rate limit exceeded: please retry after 60s',
    }
    const worker = workerWith(fakeHandle({ stdout: JSON.stringify(envelope), exitCode: 0 }))
    const handle = await worker.start(makeSpec(), ctx)
    const ev = await drainTerminal(worker, handle)
    assert.equal(ev.kind, 'failed')
    const failed = ev as Extract<WorkerEvent, { kind: 'failed' }>
    assert.equal(failed.reason, 'Rate limit exceeded: please retry after 60s')
    assert.equal(failed.recoverable, false)
    assert.deepEqual(failed.payload, envelope)
  })

  it('exit 0 + parses + is_error: true + NO error text → failed with synthetic reason', async () => {
    const envelope = { type: 'result', subtype: 'error_unknown', is_error: true }
    const worker = workerWith(fakeHandle({ stdout: JSON.stringify(envelope), exitCode: 0 }))
    const handle = await worker.start(makeSpec(), ctx)
    const ev = await drainTerminal(worker, handle)
    assert.equal(ev.kind, 'failed')
    const failed = ev as Extract<WorkerEvent, { kind: 'failed' }>
    assert.equal(failed.reason, 'subprocess reported is_error without error text')
    assert.equal(failed.recoverable, false)
    assert.deepEqual(failed.payload, envelope)
  })

  it('exit 0 + parses but envelope has no boolean is_error → failed with synthetic reason', async () => {
    const malformed = { unexpected: 'shape', no_is_error_field: true }
    const worker = workerWith(fakeHandle({ stdout: JSON.stringify(malformed), exitCode: 0 }))
    const handle = await worker.start(makeSpec(), ctx)
    const ev = await drainTerminal(worker, handle)
    assert.equal(ev.kind, 'failed')
    const failed = ev as Extract<WorkerEvent, { kind: 'failed' }>
    assert.match(failed.reason, /missing boolean is_error/)
    assert.deepEqual(failed.payload, malformed)
  })

  it('exit 0 + unparseable stdout → failed with parse-error reason', async () => {
    const worker = workerWith(fakeHandle({ stdout: 'not json at all {{{', exitCode: 0 }))
    const handle = await worker.start(makeSpec(), ctx)
    const ev = await drainTerminal(worker, handle)
    assert.equal(ev.kind, 'failed')
    const failed = ev as Extract<WorkerEvent, { kind: 'failed' }>
    assert.match(failed.reason, /unparseable subprocess stdout/)
  })

  it('exit non-zero → failed (regression guard for existing behavior)', async () => {
    const worker = workerWith(fakeHandle({ stdout: '', stderr: 'boom', exitCode: 2 }))
    const handle = await worker.start(makeSpec(), ctx)
    const ev = await drainTerminal(worker, handle)
    assert.equal(ev.kind, 'failed')
    const failed = ev as Extract<WorkerEvent, { kind: 'failed' }>
    assert.equal(failed.reason, 'boom')
    assert.equal(failed.recoverable, false)
  })

  it('signal-death with empty stderr → failed with killed-by-signal reason', async () => {
    const worker = workerWith(fakeHandle({ stdout: '', exitCode: null as unknown as number, signal: 'SIGKILL' }))
    const handle = await worker.start(makeSpec(), ctx)
    const ev = await drainTerminal(worker, handle)
    assert.equal(ev.kind, 'failed')
    assert.match((ev as Extract<WorkerEvent, { kind: 'failed' }>).reason, /killed by SIGKILL/)
  })

  // Restore env state after the describe block runs.
  it('(env cleanup)', () => {
    if (SAVED_KEY !== undefined) process.env.ANTHROPIC_API_KEY = SAVED_KEY
    else delete process.env.ANTHROPIC_API_KEY
  })
})

describe('ClaudeCodeWorker — stop() lifecycle (CI, closes #14, group semantics per #15/ADR-0004)', () => {
  // Controllable fake handle for stop() race coverage. Unlike the simple
  // fakeHandle() used by the parse-path tests above, this one:
  //   - Defers wait() resolution until the test drives it via fireExit().
  //   - Records every signal() call (name + group flag) so tests can assert
  //     on what stop() sent.
  //   - Decides per-signal whether to fire exit, which is how we model a
  //     child that ignores SIGTERM but cannot escape SIGKILL.
  type Controllable = ExecHandle & {
    signals: string[]
    groupFlags: boolean[]
    fireExit: (code: number | null, signal?: string | null) => void
    rejectWait: (err: Error) => void
  }
  function controllableHandle(opts: {
    onSigterm?: 'exit' | 'ignore'
    pid?: number | null
  } = {}): Controllable {
    const onSigterm = opts.onSigterm ?? 'exit'
    const pid = 'pid' in opts ? (opts.pid ?? null) : 12345
    let resolveWait!: (e: ExecExit) => void
    let rejectWait!: (err: Error) => void
    const waitP = new Promise<ExecExit>((res, rej) => {
      resolveWait = res
      rejectWait = rej
    })
    const stdout = new Readable({ read() {} })
    const stderr = new Readable({ read() {} })
    const c: Controllable = {
      pid,
      pgid: pid,
      stdout,
      stderr,
      wait: () => waitP,
      signals: [],
      groupFlags: [],
      signal(sig, sopts) {
        c.signals.push(sig)
        c.groupFlags.push(sopts?.group === true)
        if (sig === 'SIGTERM' && onSigterm === 'exit') {
          // Honor the term: fire exit on a microtask so the implementation's
          // race-arming code has registered its listener first.
          queueMicrotask(() => c.fireExit(143, 'SIGTERM'))
        } else if (sig === 'SIGKILL') {
          // SIGKILL is unblockable.
          queueMicrotask(() => c.fireExit(137, 'SIGKILL'))
        }
        return true
      },
      fireExit(code, signal) {
        stdout.push(null)
        stderr.push(null)
        // Resolve on a microtask so the just-pushed stream EOFs flush into
        // the worker's accumulators first (mirrors the runtime's drain).
        queueMicrotask(() => resolveWait({ exitCode: code, signal: signal ?? null }))
      },
      rejectWait(err) {
        rejectWait(err)
      },
    }
    return c
  }

  const ctx: WorkerContext = { env: { ANTHROPIC_API_KEY: 'sk-ant-fake-test-key' } }
  let SAVED_KEY: string | undefined
  beforeEach(() => {
    SAVED_KEY = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-test-key'
  })
  afterEach(() => {
    if (SAVED_KEY !== undefined) process.env.ANTHROPIC_API_KEY = SAVED_KEY
    else delete process.env.ANTHROPIC_API_KEY
  })

  it('stop() called twice → second call returns same promise, only one SIGTERM sent', async () => {
    const h = controllableHandle({ onSigterm: 'exit' })
    const worker = workerWith(h)
    const handle = await worker.start(makeSpec(), ctx)
    const p1 = worker.stop(handle, 'first')
    const p2 = worker.stop(handle, 'second')
    assert.strictEqual(p1, p2, 'second stop() must return the same promise reference')
    await p1
    assert.deepEqual(h.signals, ['SIGTERM'], 'only one SIGTERM sent for concurrent stop() calls')
  })

  it('stop() signals the GROUP from the first SIGTERM (ADR-0004 group-first escalation)', async () => {
    const h = controllableHandle({ onSigterm: 'exit' })
    const worker = workerWith(h)
    const handle = await worker.start(makeSpec(), ctx)
    await worker.stop(handle, 'graceful')
    assert.deepEqual(h.groupFlags, [true], 'SIGTERM must target the process group, not just the leader')
  })

  it('stop() on a child that exits within grace → SIGTERM only, terminationMode=sigterm', async () => {
    const h = controllableHandle({ onSigterm: 'exit' })
    const worker = workerWith(h)
    const handle = await worker.start(makeSpec(), ctx)
    await worker.stop(handle, 'graceful')
    assert.deepEqual(h.signals, ['SIGTERM'], 'SIGKILL must not be sent when SIGTERM is honored')
    const ev = await drainTerminal(worker, handle)
    assert.equal(ev.kind, 'failed')
    const failed = ev as Extract<WorkerEvent, { kind: 'failed' }>
    assert.equal(failed.terminationMode, 'sigterm')
  })

  it('stop() on a child that ignores SIGTERM → group SIGKILL after grace, terminationMode=sigkill', async () => {
    // Fake timers (apis: ['setTimeout'] only — leave setImmediate /
    // queueMicrotask alone so the controllable handle can still drive its
    // exit emission). This is what keeps the SIGTERM-ignored test in the
    // millisecond range; a real 10s wait in CI is unacceptable.
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const h = controllableHandle({ onSigterm: 'ignore' })
      const worker = workerWith(h)
      const handle = await worker.start(makeSpec(), ctx)
      const startedAt = Date.now()
      const stopPromise = worker.stop(handle, 'budget cap')
      // Let stop() send SIGTERM and arm its timer.
      await new Promise<void>((r) => setImmediate(r))
      assert.deepEqual(h.signals, ['SIGTERM'], 'SIGTERM must be sent before grace elapses')
      // Advance virtual time past the grace window.
      mock.timers.tick(STOP_GRACE_MS + 100)
      await stopPromise
      // Generous tolerance — we're asserting "did not take wall-clock 10s",
      // not a precise duration. Anything under a second proves fake timers
      // are doing their job.
      assert.ok(
        Date.now() - startedAt < 1000,
        `stop() took ${Date.now() - startedAt}ms wall-clock; fake timers not in effect`,
      )
      assert.deepEqual(
        h.signals,
        ['SIGTERM', 'SIGKILL'],
        'SIGKILL must be sent after grace when SIGTERM was ignored',
      )
      assert.deepEqual(h.groupFlags, [true, true], 'both signals must target the group')
      const ev = await drainTerminal(worker, handle)
      assert.equal(ev.kind, 'failed')
      const failed = ev as Extract<WorkerEvent, { kind: 'failed' }>
      assert.equal(failed.terminationMode, 'sigkill')
    } finally {
      mock.timers.reset()
    }
  })

  it('stop() called after stream() has already terminated naturally → resolves immediately, no signal sent', async () => {
    const envelope = { type: 'result', subtype: 'success', is_error: false, result: 'OK' }
    let signalCount = 0
    const base = fakeHandle({ stdout: JSON.stringify(envelope), exitCode: 0 })
    const h: ExecHandle = {
      ...base,
      signal: () => {
        signalCount++
        return true
      },
    }
    const worker = workerWith(h)
    const handle = await worker.start(makeSpec(), ctx)
    const ev = await drainTerminal(worker, handle)
    assert.equal(ev.kind, 'complete')
    // State is now 'complete'. stop() must take the fast path.
    await worker.stop(handle, 'too late')
    assert.equal(signalCount, 0, 'no signal should be sent after natural termination')
  })

  it('stop() called mid-spawn (no pid) → resolves once spawn settles, no error on spawn failure', async () => {
    const h = controllableHandle({ pid: null })
    const worker = workerWith(h)
    const handle = await worker.start(makeSpec(), ctx)
    const stopPromise = worker.stop(handle, 'never started')
    // Simulate spawn failure landing after stop() was called.
    queueMicrotask(() => h.rejectWait(new Error('spawn ENOENT')))
    await stopPromise
    assert.deepEqual(
      h.signals,
      [],
      'no signal should be issued when pid is unknown — wait for spawn to settle instead',
    )
  })
})

describe('ClaudeCodeWorker — tokens event from usage block (CI, closes #13)', () => {
  // Drain every event from stream() into an array so order assertions ("tokens
  // before complete") and presence/absence assertions are both easy to write.
  async function drainAll(worker: ClaudeCodeWorker, handle: string): Promise<WorkerEvent[]> {
    const out: WorkerEvent[] = []
    for await (const ev of worker.stream(handle)) {
      out.push(ev)
      if (ev.kind === 'complete' || ev.kind === 'failed') break
    }
    return out
  }

  const ctx: WorkerContext = { env: { ANTHROPIC_API_KEY: 'sk-ant-fake-test-key' } }
  let SAVED_KEY: string | undefined
  beforeEach(() => {
    SAVED_KEY = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-test-key'
  })
  afterEach(() => {
    if (SAVED_KEY !== undefined) process.env.ANTHROPIC_API_KEY = SAVED_KEY
    else delete process.env.ANTHROPIC_API_KEY
  })

  it('envelope with usage (no cache fields) → tokens emitted before complete with input/output only', async () => {
    const envelope = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'OK',
      usage: { input_tokens: 123, output_tokens: 45 },
    }
    const worker = workerWith(fakeHandle({ stdout: JSON.stringify(envelope), exitCode: 0 }))
    const handle = await worker.start(makeSpec(), ctx)
    const events = await drainAll(worker, handle)
    const tokensIdx = events.findIndex((e) => e.kind === 'tokens')
    const completeIdx = events.findIndex((e) => e.kind === 'complete')
    assert.notEqual(tokensIdx, -1, 'tokens event must be emitted')
    assert.notEqual(completeIdx, -1, 'complete event must be emitted')
    assert.ok(tokensIdx < completeIdx, 'tokens must precede complete')
    const tokens = events[tokensIdx] as Extract<WorkerEvent, { kind: 'tokens' }>
    assert.equal(tokens.inputTokens, 123)
    assert.equal(tokens.outputTokens, 45)
    assert.ok(
      !('cacheCreationInputTokens' in tokens),
      'absent cache fields must be omitted from the event, not set to zero/undefined',
    )
    assert.ok(!('cacheReadInputTokens' in tokens))
  })

  it('envelope with cache-token fields → forwarded onto the tokens event', async () => {
    const envelope = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'OK',
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 1500,
      },
    }
    const worker = workerWith(fakeHandle({ stdout: JSON.stringify(envelope), exitCode: 0 }))
    const handle = await worker.start(makeSpec(), ctx)
    const events = await drainAll(worker, handle)
    const tokens = events.find((e) => e.kind === 'tokens') as
      | Extract<WorkerEvent, { kind: 'tokens' }>
      | undefined
    assert.ok(tokens, 'tokens event must be emitted')
    assert.equal(tokens.inputTokens, 10)
    assert.equal(tokens.outputTokens, 20)
    assert.equal(tokens.cacheCreationInputTokens, 500)
    assert.equal(tokens.cacheReadInputTokens, 1500)
  })

  it('envelope without usage block → no tokens event, complete still emitted, no error', async () => {
    const envelope = { type: 'result', subtype: 'success', is_error: false, result: 'OK' }
    const worker = workerWith(fakeHandle({ stdout: JSON.stringify(envelope), exitCode: 0 }))
    const handle = await worker.start(makeSpec(), ctx)
    const events = await drainAll(worker, handle)
    assert.equal(
      events.find((e) => e.kind === 'tokens'),
      undefined,
      'missing usage block must NOT produce a tokens event',
    )
    assert.equal(
      events.find((e) => e.kind === 'log'),
      undefined,
      'missing usage is silent (degraded telemetry), not a warning',
    )
    const terminal = events[events.length - 1]
    assert.equal(terminal!.kind, 'complete')
  })

  it('envelope with usage as a non-object (string) → no tokens, warn log, complete still emitted', async () => {
    const envelope = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'OK',
      usage: 'not an object at all',
    }
    const worker = workerWith(fakeHandle({ stdout: JSON.stringify(envelope), exitCode: 0 }))
    const handle = await worker.start(makeSpec(), ctx)
    const events = await drainAll(worker, handle)
    assert.equal(events.find((e) => e.kind === 'tokens'), undefined)
    const log = events.find((e) => e.kind === 'log') as
      | Extract<WorkerEvent, { kind: 'log' }>
      | undefined
    assert.ok(log, 'malformed usage must produce a warn log')
    assert.equal(log.level, 'warn')
    assert.match(log.message, /usage block malformed/)
    const terminal = events[events.length - 1]
    assert.equal(terminal!.kind, 'complete')
  })

  it('envelope with non-numeric counts → no tokens, warn log, complete still emitted', async () => {
    const envelope = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'OK',
      usage: { input_tokens: 'lots', output_tokens: null },
    }
    const worker = workerWith(fakeHandle({ stdout: JSON.stringify(envelope), exitCode: 0 }))
    const handle = await worker.start(makeSpec(), ctx)
    const events = await drainAll(worker, handle)
    assert.equal(events.find((e) => e.kind === 'tokens'), undefined)
    const log = events.find((e) => e.kind === 'log') as
      | Extract<WorkerEvent, { kind: 'log' }>
      | undefined
    assert.ok(log, 'malformed usage must produce a warn log')
    assert.equal(log.level, 'warn')
    assert.match(log.message, /input_tokens\/output_tokens missing or non-numeric/)
    const terminal = events[events.length - 1]
    assert.equal(terminal!.kind, 'complete')
  })

  it('envelope with is_error: true (even if usage present) → no tokens event on the failed path', async () => {
    // Cheap version doesn't bill failed paths. The Claude Code envelope may
    // carry partial usage on failure; capturing that requires per-message
    // tracking (stream-json), deferred to the p3 follow-up (#26).
    const envelope = {
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      result: 'Rate limit exceeded',
      usage: { input_tokens: 999, output_tokens: 1 },
    }
    const worker = workerWith(fakeHandle({ stdout: JSON.stringify(envelope), exitCode: 0 }))
    const handle = await worker.start(makeSpec(), ctx)
    const events = await drainAll(worker, handle)
    assert.equal(
      events.find((e) => e.kind === 'tokens'),
      undefined,
      'failed envelopes must not emit tokens in the cheap version',
    )
    const terminal = events[events.length - 1]
    assert.equal(terminal!.kind, 'failed')
  })
})

describe('ClaudeCodeWorker — heartbeats (CI, closes #11)', () => {
  // Long-lived fake handle for the multi-heartbeat tests: stdout/stderr stay
  // open and wait() never settles, so session.resolved never settles on its
  // own. Cleanup is the test's responsibility — call iterator.return() or
  // drive fireExit() manually.
  type Controllable = ExecHandle & {
    signals: string[]
    fireExit: (code: number | null, signal?: string | null) => void
    rejectWait: (err: Error) => void
    pushStdout: (chunk: string) => void
  }
  function controllableHandle(opts: {
    onSigterm?: 'exit' | 'ignore'
    pid?: number | null
  } = {}): Controllable {
    const onSigterm = opts.onSigterm ?? 'ignore'
    const pid = 'pid' in opts ? (opts.pid ?? null) : 12345
    let resolveWait!: (e: ExecExit) => void
    let rejectWaitFn!: (err: Error) => void
    const waitP = new Promise<ExecExit>((res, rej) => {
      resolveWait = res
      rejectWaitFn = rej
    })
    const stdout = new Readable({ read() {} })
    const stderr = new Readable({ read() {} })
    const c: Controllable = {
      pid,
      pgid: pid,
      stdout,
      stderr,
      wait: () => waitP,
      signals: [],
      signal(sig) {
        c.signals.push(sig)
        if (sig === 'SIGTERM' && onSigterm === 'exit') {
          queueMicrotask(() => c.fireExit(143, 'SIGTERM'))
        } else if (sig === 'SIGKILL') {
          queueMicrotask(() => c.fireExit(137, 'SIGKILL'))
        }
        return true
      },
      fireExit(code, signal) {
        stdout.push(null)
        stderr.push(null)
        queueMicrotask(() => resolveWait({ exitCode: code, signal: signal ?? null }))
      },
      rejectWait(err) {
        rejectWaitFn(err)
      },
      pushStdout(chunk) {
        stdout.push(chunk)
      },
    }
    return c
  }

  const ctx: WorkerContext = { env: { ANTHROPIC_API_KEY: 'sk-ant-fake-test-key' } }
  let SAVED_KEY: string | undefined
  beforeEach(() => {
    SAVED_KEY = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-test-key'
  })
  afterEach(() => {
    if (SAVED_KEY !== undefined) process.env.ANTHROPIC_API_KEY = SAVED_KEY
    else delete process.env.ANTHROPIC_API_KEY
  })

  it('long-running subprocess yields ≥2 heartbeats within HEARTBEAT_INTERVAL_MS * 2.5, strictly increasing at, lastEventAt updates', async () => {
    // mock.timers covers BOTH setTimeout (heartbeat tick) AND Date so the at
    // values reflect virtual time — otherwise two heartbeats fired in the same
    // wall-clock millisecond would share an at value and the "strictly
    // increasing" assertion would be untestable.
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    try {
      const h = controllableHandle()
      const worker = workerWith(h)
      const handle = await worker.start(makeSpec(), ctx)
      const iter = worker.stream(handle)[Symbol.asyncIterator]()

      // First heartbeat: arm fires at HEARTBEAT_INTERVAL_MS.
      const p1 = iter.next()
      mock.timers.tick(HEARTBEAT_INTERVAL_MS)
      const r1 = await p1
      assert.equal(r1.done, false)
      assert.equal(r1.value!.kind, 'heartbeat')
      const hb1 = r1.value as Extract<WorkerEvent, { kind: 'heartbeat' }>
      const s1 = await worker.status(handle)
      assert.equal(s1.lastEventAt, hb1.at, 'lastEventAt must update on heartbeat')

      // Second heartbeat: debounced — fires another HEARTBEAT_INTERVAL_MS after
      // the first. Total virtual elapsed = 2 * HEARTBEAT_INTERVAL_MS, well
      // within the 2.5x window the spec requires.
      const p2 = iter.next()
      mock.timers.tick(HEARTBEAT_INTERVAL_MS)
      const r2 = await p2
      assert.equal(r2.value!.kind, 'heartbeat')
      const hb2 = r2.value as Extract<WorkerEvent, { kind: 'heartbeat' }>
      assert.ok(hb2.at > hb1.at, `heartbeat at must strictly increase: ${hb1.at} → ${hb2.at}`)
      const s2 = await worker.status(handle)
      assert.equal(s2.lastEventAt, hb2.at)

      await iter.return!()
    } finally {
      mock.timers.reset()
    }
  })

  it('subprocess emits terminal events within one HEARTBEAT_INTERVAL_MS → zero heartbeats emitted', async () => {
    // The natural event(s) reset the heartbeat timer on every yield, so a
    // stream that terminates quickly never emits a synthetic heartbeat. No
    // mock.timers needed — real wall time is microseconds, far under the 25s
    // tick interval.
    const envelope = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'OK',
      usage: { input_tokens: 5, output_tokens: 7 },
    }
    const worker = workerWith(fakeHandle({ stdout: JSON.stringify(envelope), exitCode: 0 }))
    const handle = await worker.start(makeSpec(), ctx)
    const events: WorkerEvent[] = []
    for await (const ev of worker.stream(handle)) {
      events.push(ev)
      if (ev.kind === 'complete' || ev.kind === 'failed') break
    }
    assert.equal(
      events.filter((e) => e.kind === 'heartbeat').length,
      0,
      'heartbeats must NOT fire when natural events are keeping the stream fresh',
    )
    // Sanity: tokens + complete still landed.
    assert.ok(events.find((e) => e.kind === 'tokens'))
    assert.equal(events[events.length - 1]!.kind, 'complete')
  })

  it('debounce: natural event resets the heartbeat timer; original would-have-fired tick does NOT emit', async () => {
    // Pins the reset-on-every-yield invariant inside enqueue(): advance to
    // 1ms before the initial heartbeat would fire (no heartbeat yet), then
    // route natural events through enqueue() via child exit (tokens +
    // complete), then advance past the original deadline. The original
    // timer was cleared by the first enqueue, so no heartbeat must land.
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    try {
      const h = controllableHandle({ onSigterm: 'ignore' })
      const worker = workerWith(h)
      const handle = await worker.start(makeSpec(), ctx)

      const events: WorkerEvent[] = []
      const drain = (async () => {
        for await (const ev of worker.stream(handle)) {
          events.push(ev)
          if (ev.kind === 'complete' || ev.kind === 'failed') break
        }
      })()
      // Let stream() arm its initial heartbeat timer and enter the wait loop.
      await new Promise<void>((r) => setImmediate(r))

      // Advance to 1ms before HEARTBEAT_INTERVAL_MS — original timer is armed
      // but has not fired. Heartbeats must still be zero.
      mock.timers.tick(HEARTBEAT_INTERVAL_MS - 1)
      await new Promise<void>((r) => setImmediate(r))
      assert.equal(
        events.filter((e) => e.kind === 'heartbeat').length,
        0,
        'no heartbeat may fire 1ms before HEARTBEAT_INTERVAL_MS',
      )

      // Yield natural events via exit. driveCompletion enqueues tokens then
      // complete; each enqueue() clears the pending heartbeat timer.
      const envelope = {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'OK',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
      h.pushStdout(JSON.stringify(envelope))
      await new Promise<void>((r) => setImmediate(r))
      h.fireExit(0, null)
      await new Promise<void>((r) => setImmediate(r))
      await new Promise<void>((r) => setImmediate(r))

      // Advance past the original-would-have-fired deadline (and past where
      // any newly-armed post-enqueue timer would fire). A leaked original
      // timer would emit a heartbeat now — assert it does not.
      mock.timers.tick(HEARTBEAT_INTERVAL_MS * 2)
      await drain

      assert.equal(
        events.filter((e) => e.kind === 'heartbeat').length,
        0,
        'natural events must reset the heartbeat timer; the original deadline must NOT emit',
      )
      assert.equal(events[events.length - 1]!.kind, 'complete')
    } finally {
      mock.timers.reset()
    }
  })

  it('stop() mid-stream → no heartbeats emitted between SIGTERM and exit', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    try {
      const h = controllableHandle({ onSigterm: 'ignore' })
      const worker = workerWith(h)
      const handle = await worker.start(makeSpec(), ctx)

      const events: WorkerEvent[] = []
      const drain = (async () => {
        for await (const ev of worker.stream(handle)) {
          events.push(ev)
          if (ev.kind === 'complete' || ev.kind === 'failed') break
        }
      })()

      // Let the stream() generator arm its initial heartbeat timer and enter
      // the wait-for-event state.
      await new Promise<void>((r) => setImmediate(r))

      // Drive stop(): group SIGTERM, state → 'cancelled', grace timer armed,
      // group SIGKILL after STOP_GRACE_MS, handle resolves, driveCompletion
      // enqueues failed terminal. Advance well past both the grace window AND
      // multiple HEARTBEAT_INTERVAL_MS so any leaked heartbeat tick would fire.
      const stopPromise = worker.stop(handle, 'mid-stream cancel')
      await new Promise<void>((r) => setImmediate(r))
      mock.timers.tick(HEARTBEAT_INTERVAL_MS * 3)
      await stopPromise
      await drain

      assert.equal(
        events.filter((e) => e.kind === 'heartbeat').length,
        0,
        'no heartbeats may be emitted between SIGTERM and exit — state was cancelled, tick must skip',
      )
      const terminal = events[events.length - 1]!
      assert.equal(terminal.kind, 'failed')
      assert.equal(
        (terminal as Extract<WorkerEvent, { kind: 'failed' }>).terminationMode,
        'sigkill',
        'SIGTERM was ignored → SIGKILL escalation expected',
      )
    } finally {
      mock.timers.reset()
    }
  })

  it('spawn error before child PID known → heartbeat timer cleared, no leak', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    try {
      const h = controllableHandle({ pid: null })
      const worker = workerWith(h)
      const handle = await worker.start(makeSpec(), ctx)
      // Simulate spawn failure landing right after start() returns.
      queueMicrotask(() => h.rejectWait(new Error('spawn ENOENT')))

      const events: WorkerEvent[] = []
      for await (const ev of worker.stream(handle)) {
        events.push(ev)
        if (ev.kind === 'complete' || ev.kind === 'failed') break
      }
      // Generator has returned; its finally cleared the timer. Advance virtual
      // time well past HEARTBEAT_INTERVAL_MS — if the timer were leaking, it
      // would tick now. Cleanest assertion: events array unchanged after tick.
      const sizeBeforeTick = events.length
      mock.timers.tick(HEARTBEAT_INTERVAL_MS * 3)
      assert.equal(events.length, sizeBeforeTick, 'no late heartbeats after generator return')
      assert.equal(events.length, 1)
      assert.equal(events[0]!.kind, 'failed')
      assert.equal(
        events.filter((e) => e.kind === 'heartbeat').length,
        0,
        'no heartbeat must fire when spawn errors before stream() starts iterating in earnest',
      )
    } finally {
      mock.timers.reset()
    }
  })
})

describe('ClaudeCodeWorker — lastEventAt updates at every WorkerEvent yield site (CI, closes #12)', () => {
  const ctx: WorkerContext = { env: { ANTHROPIC_API_KEY: 'sk-ant-fake-test-key' } }
  let SAVED_KEY: string | undefined
  beforeEach(() => {
    SAVED_KEY = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-test-key'
  })
  afterEach(() => {
    if (SAVED_KEY !== undefined) process.env.ANTHROPIC_API_KEY = SAVED_KEY
    else delete process.env.ANTHROPIC_API_KEY
  })

  // One it() per yield site so a regression points at the broken path. Each
  // case drives the stream, then after every yielded event asserts that
  // status().lastEventAt matches the event's at — proving lastEventAt was
  // refreshed before the consumer observed the event.
  const cases: Array<{
    name: string
    stdout: string
    stderr?: string
    exitCode: number
    expectedKinds: WorkerEvent['kind'][]
  }> = [
    {
      name: 'success path: tokens + complete',
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'OK',
        usage: { input_tokens: 1, output_tokens: 2 },
      }),
      exitCode: 0,
      expectedKinds: ['tokens', 'complete'],
    },
    {
      name: 'malformed usage: log (warn) + complete',
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'OK',
        usage: 'not an object',
      }),
      exitCode: 0,
      expectedKinds: ['log', 'complete'],
    },
    {
      name: 'failed: envelope is_error true',
      stdout: JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        is_error: true,
        result: 'boom',
      }),
      exitCode: 0,
      expectedKinds: ['failed'],
    },
    {
      name: 'failed: envelope missing boolean is_error',
      stdout: JSON.stringify({ unexpected: 'shape' }),
      exitCode: 0,
      expectedKinds: ['failed'],
    },
    {
      name: 'failed: unparseable stdout',
      stdout: 'not json {{{',
      exitCode: 0,
      expectedKinds: ['failed'],
    },
    {
      name: 'failed: non-zero exit',
      stdout: '',
      stderr: 'boom',
      exitCode: 2,
      expectedKinds: ['failed'],
    },
  ]

  for (const c of cases) {
    it(`updates lastEventAt before yielding — ${c.name}`, async () => {
      const worker = workerWith(
        fakeHandle({ stdout: c.stdout, stderr: c.stderr ?? '', exitCode: c.exitCode }),
      )
      const handle = await worker.start(makeSpec(), ctx)
      const observed: WorkerEvent['kind'][] = []
      for await (const ev of worker.stream(handle)) {
        const status = await worker.status(handle)
        assert.equal(
          status.lastEventAt,
          ev.at,
          `lastEventAt must equal the just-yielded event's at (kind=${ev.kind}, scenario=${c.name})`,
        )
        observed.push(ev.kind)
        if (ev.kind === 'complete' || ev.kind === 'failed') break
      }
      assert.deepEqual(observed, c.expectedKinds, `expected event sequence for ${c.name}`)
    })
  }

  it('updates lastEventAt before yielding — heartbeat', async () => {
    // Heartbeat doesn't fit the fakeHandle pattern above (resolves
    // immediately, never quiet long enough for the heartbeat timer to fire).
    // Use a handle whose wait() never settles plus mock.timers to fire one
    // heartbeat, then assert session.lastEventAt matches the heartbeat's at.
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    try {
      const h: ExecHandle = {
        pid: 12345,
        pgid: 12345,
        stdout: new Readable({ read() {} }),
        stderr: new Readable({ read() {} }),
        wait: () => new Promise<ExecExit>(() => {}),
        signal: () => true,
      }
      const worker = workerWith(h)
      const handle = await worker.start(makeSpec(), ctx)
      const iter = worker.stream(handle)[Symbol.asyncIterator]()

      const p = iter.next()
      mock.timers.tick(HEARTBEAT_INTERVAL_MS)
      const r = await p
      assert.equal(r.done, false)
      assert.equal(r.value!.kind, 'heartbeat')
      const hb = r.value as Extract<WorkerEvent, { kind: 'heartbeat' }>
      const status = await worker.status(handle)
      assert.equal(
        status.lastEventAt,
        hb.at,
        'lastEventAt must equal the heartbeat event.at after yield',
      )

      await iter.return!()
    } finally {
      mock.timers.reset()
    }
  })
})

const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === '1'
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY
const INTEGRATION_SKIP_REASON = !RUN_INTEGRATION
  ? 'set RUN_INTEGRATION_TESTS=1 to run real-subprocess tests'
  : !HAS_KEY
    ? 'ANTHROPIC_API_KEY is required for the happy-path integration test; set a throwaway, per-key-spend-capped key'
    : false

describe('ClaudeCodeWorker — real subprocess (integration)', { skip: INTEGRATION_SKIP_REASON }, () => {
  it('happy path: spawns claude -p --bare via GitWorktreeRuntime and returns parsed JSON result', async () => {
    // Production wiring, production allowlist (DX F4): a real
    // GitWorktreeRuntime, unmanaged workspace (cwd), real `claude` binary.
    const worker = new ClaudeCodeWorker({ runtime: new GitWorktreeRuntime() })
    const ctx: WorkerContext = { env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! } }
    const handle = await worker.start(makeSpec(), ctx)
    let terminal: WorkerEvent | null = null
    for await (const event of worker.stream(handle)) {
      if (event.kind === 'complete' || event.kind === 'failed') {
        terminal = event
        break
      }
    }
    assert.ok(terminal, 'stream must produce a terminal event')
    assert.equal(
      terminal.kind,
      'complete',
      `expected complete, got failed: ${(terminal as { reason?: string }).reason}`
    )
    const result = (terminal as unknown as { result: { is_error?: boolean } }).result
    assert.equal(typeof result, 'object')
    assert.equal(result.is_error, false, 'claude reported an API error; key invalid or quota hit?')
  })
})
