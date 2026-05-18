import { beforeEach, afterEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'

import {
  ClaudeCodeWorker,
  MISSING_API_KEY_MESSAGE,
  STOP_GRACE_MS,
  buildSpawnEnv,
  buildSpawnPlan,
  resolveApiKey,
  type SpawnFn,
} from '../../src/workers/claude-code-worker.ts'
import type { TaskSpec, WorkerContext, WorkerEvent } from '../../src/workers/types.ts'

// Build a minimal fake ChildProcess: stdout/stderr as Readables that emit the
// provided strings then end; 'close' fires on the next tick with exitCode.
function fakeChild(opts: { stdout?: string; stderr?: string; exitCode: number }): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess
  ;(emitter as { pid?: number }).pid = 12345
  emitter.stdout = Readable.from([opts.stdout ?? '']) as ChildProcess['stdout']
  emitter.stderr = Readable.from([opts.stderr ?? '']) as ChildProcess['stderr']
  // Defer close until both streams have finished pumping into the worker's
  // 'data' handlers, otherwise the close fires before stdout is read.
  setImmediate(() => {
    setImmediate(() => {
      emitter.emit('close', opts.exitCode)
    })
  })
  return emitter
}

function fakeSpawn(opts: { stdout?: string; stderr?: string; exitCode: number }): SpawnFn {
  return () => fakeChild(opts)
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
      assert.throws(() => new ClaudeCodeWorker(), (err: unknown) => {
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
      assert.throws(() => new ClaudeCodeWorker(), /ANTHROPIC_API_KEY/)
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved
      else delete process.env.ANTHROPIC_API_KEY
    }
  })

  it('spawn plan always includes --bare (regression guard for ADR-0002)', () => {
    const plan = buildSpawnPlan(makeSpec(), 'sk-ant-fake-test-key')
    assert.equal(plan.command, 'claude')
    assert.ok(plan.args.includes('--bare'), `expected --bare in args: ${plan.args.join(' ')}`)
    assert.ok(plan.args.includes('-p'), '`-p` (print) flag required for non-interactive use')
    const fmtIdx = plan.args.indexOf('--output-format')
    assert.notEqual(fmtIdx, -1, '--output-format required for structured parsing')
    assert.equal(plan.args[fmtIdx + 1], 'json')
  })

  it('spawn plan injects ANTHROPIC_API_KEY into env', () => {
    const plan = buildSpawnPlan(makeSpec(), 'sk-ant-fake-test-key')
    const env = plan.options.env as Record<string, string>
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-fake-test-key')
  })

  it('spawn plan does NOT write any credential file path into args', () => {
    const plan = buildSpawnPlan(makeSpec(), 'sk-ant-fake-test-key')
    const joined = plan.args.join(' ')
    assert.doesNotMatch(joined, /credentials\.json/)
    assert.doesNotMatch(joined, /\.claude\//)
  })

  it('spawn env contains exactly the allowlist keys plus ANTHROPIC_API_KEY, no others (closes #8)', () => {
    // Pollute process.env with a known-bad set covering every category from
    // issue #8: endpoint redirect, provider switch, model override, alt-auth,
    // OAuth side-channel, 3P provider creds, NODE_OPTIONS, HTTP_PROXY, plus
    // an arbitrary leak canary. None of these may appear in the spawn env.
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
          `${k} leaked into spawn env — allowlist breach`,
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
          `unexpected key in spawn env: ${k} (not in allowlist)`,
        )
      }
    } finally {
      for (const k of Object.keys(polluted)) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  })

  it('spawn env passes through allowlist keys when defined in process.env', () => {
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

  it('spawn env omits allowlist keys that are absent from process.env (no empty-string padding)', () => {
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

  it('spawn plan does NOT detach the child (orphan-prevention)', () => {
    const plan = buildSpawnPlan(makeSpec(), 'sk-ant-fake-test-key')
    assert.notEqual(
      plan.options.detached,
      true,
      'detached: true would orphan the worker if the daemon dies — keeps billing',
    )
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
  // The seam is constructor-injected spawnImpl; every test here builds a fake
  // child that emits the stdout/exit-code shape under test, then drains the
  // stream for the terminal event.
  const ctx: WorkerContext = { env: { ANTHROPIC_API_KEY: 'sk-ant-fake-test-key' } }
  const SAVED_KEY = process.env.ANTHROPIC_API_KEY
  process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-test-key'

  it('exit 0 + parses + is_error: false → complete with result payload', async () => {
    const envelope = { type: 'result', subtype: 'success', is_error: false, result: 'OK' }
    const worker = new ClaudeCodeWorker({
      spawnImpl: fakeSpawn({ stdout: JSON.stringify(envelope), exitCode: 0 }),
    })
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
    const worker = new ClaudeCodeWorker({
      spawnImpl: fakeSpawn({ stdout: JSON.stringify(envelope), exitCode: 0 }),
    })
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
    const worker = new ClaudeCodeWorker({
      spawnImpl: fakeSpawn({ stdout: JSON.stringify(envelope), exitCode: 0 }),
    })
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
    const worker = new ClaudeCodeWorker({
      spawnImpl: fakeSpawn({ stdout: JSON.stringify(malformed), exitCode: 0 }),
    })
    const handle = await worker.start(makeSpec(), ctx)
    const ev = await drainTerminal(worker, handle)
    assert.equal(ev.kind, 'failed')
    const failed = ev as Extract<WorkerEvent, { kind: 'failed' }>
    assert.match(failed.reason, /missing boolean is_error/)
    assert.deepEqual(failed.payload, malformed)
  })

  it('exit 0 + unparseable stdout → failed with parse-error reason', async () => {
    const worker = new ClaudeCodeWorker({
      spawnImpl: fakeSpawn({ stdout: 'not json at all {{{', exitCode: 0 }),
    })
    const handle = await worker.start(makeSpec(), ctx)
    const ev = await drainTerminal(worker, handle)
    assert.equal(ev.kind, 'failed')
    const failed = ev as Extract<WorkerEvent, { kind: 'failed' }>
    assert.match(failed.reason, /unparseable subprocess stdout/)
  })

  it('exit non-zero → failed (regression guard for existing behavior)', async () => {
    const worker = new ClaudeCodeWorker({
      spawnImpl: fakeSpawn({ stdout: '', stderr: 'boom', exitCode: 2 }),
    })
    const handle = await worker.start(makeSpec(), ctx)
    const ev = await drainTerminal(worker, handle)
    assert.equal(ev.kind, 'failed')
    const failed = ev as Extract<WorkerEvent, { kind: 'failed' }>
    assert.equal(failed.reason, 'boom')
    assert.equal(failed.recoverable, false)
  })

  // Restore env state after the describe block runs.
  it('(env cleanup)', () => {
    if (SAVED_KEY !== undefined) process.env.ANTHROPIC_API_KEY = SAVED_KEY
    else delete process.env.ANTHROPIC_API_KEY
  })
})

describe('ClaudeCodeWorker — stop() lifecycle (CI, closes #14)', () => {
  // Controllable fake child for stop() race coverage. Unlike the simple
  // fakeChild() used by the parse-path tests above, this one:
  //   - Defers 'close' until we drive it (so stop() races aren't pre-decided
  //     by the simple fakeChild's setImmediate-close pattern).
  //   - Records every kill() signal so tests can assert on what stop() sent.
  //   - Decides per-signal whether to fire 'exit' / 'close', which is how we
  //     model a child that ignores SIGTERM but cannot escape SIGKILL.
  //   - Implementation uses child.kill(signal) (not process.kill(pid, signal))
  //     so this fake intercepts cleanly — no live PIDs are signaled.
  type Controllable = ChildProcess & {
    signals: NodeJS.Signals[]
    fireExit: (code: number, signal?: NodeJS.Signals | null) => void
  }
  function controllableChild(opts: {
    onSigterm?: 'exit' | 'ignore'
    pid?: number | null
  } = {}): Controllable {
    const onSigterm = opts.onSigterm ?? 'exit'
    const c = new EventEmitter() as Controllable
    // `pid: null` lets tests model the mid-spawn-no-pid case. Plain omission
    // gets a default. Cannot use `?? 12345` because that would coerce null to
    // the default.
    c.pid = 'pid' in opts ? (opts.pid ?? undefined) : 12345
    // Stdout/stderr exist but emit nothing (we don't care about parse paths
    // here — stop() must terminate before the subprocess writes useful output).
    c.stdout = new Readable({ read() {} }) as ChildProcess['stdout']
    c.stderr = new Readable({ read() {} }) as ChildProcess['stderr']
    c.exitCode = null
    c.signalCode = null
    c.killed = false
    c.signals = []
    c.kill = ((signal?: NodeJS.Signals | number) => {
      const sig = (typeof signal === 'string' ? signal : 'SIGTERM') as NodeJS.Signals
      c.signals.push(sig)
      if (sig === 'SIGTERM' && onSigterm === 'exit') {
        // Honor the term: fire exit on a microtask so the implementation's
        // race-arming code has registered its listener first.
        queueMicrotask(() => c.fireExit(143, 'SIGTERM'))
      } else if (sig === 'SIGKILL') {
        // SIGKILL is unblockable.
        queueMicrotask(() => c.fireExit(137, 'SIGKILL'))
      }
      return true
    }) as ChildProcess['kill']
    c.fireExit = (code, signal) => {
      c.exitCode = code
      if (signal != null) c.signalCode = signal
      c.killed = true
      // Read the stdout/stderr we never populated to nudge the worker's
      // accumulators closed before 'close' fires.
      ;(c.stdout as Readable).push(null)
      ;(c.stderr as Readable).push(null)
      c.emit('exit', code, signal ?? null)
      // Worker's `resolved` listens on 'close', not 'exit'. Fire both so the
      // stream() drainer can proceed and assert on terminationMode.
      queueMicrotask(() => c.emit('close', code, signal ?? null))
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
    const child = controllableChild({ onSigterm: 'exit' })
    const worker = new ClaudeCodeWorker({ spawnImpl: () => child })
    const handle = await worker.start(makeSpec(), ctx)
    const p1 = worker.stop(handle, 'first')
    const p2 = worker.stop(handle, 'second')
    assert.strictEqual(p1, p2, 'second stop() must return the same promise reference')
    await p1
    assert.deepEqual(child.signals, ['SIGTERM'], 'only one SIGTERM sent for concurrent stop() calls')
  })

  it('stop() on a child that exits within grace → SIGTERM only, terminationMode=sigterm', async () => {
    const child = controllableChild({ onSigterm: 'exit' })
    const worker = new ClaudeCodeWorker({ spawnImpl: () => child })
    const handle = await worker.start(makeSpec(), ctx)
    await worker.stop(handle, 'graceful')
    assert.deepEqual(child.signals, ['SIGTERM'], 'SIGKILL must not be sent when SIGTERM is honored')
    const ev = await drainTerminal(worker, handle)
    assert.equal(ev.kind, 'failed')
    const failed = ev as Extract<WorkerEvent, { kind: 'failed' }>
    assert.equal(failed.terminationMode, 'sigterm')
  })

  it('stop() on a child that ignores SIGTERM → SIGKILL after grace, terminationMode=sigkill', async () => {
    // Fake timers (apis: ['setTimeout'] only — leave setImmediate /
    // queueMicrotask alone so the controllable child can still drive its
    // exit emission). This is what keeps the SIGTERM-ignored test in the
    // millisecond range; a real 10s wait in CI is unacceptable.
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const child = controllableChild({ onSigterm: 'ignore' })
      const worker = new ClaudeCodeWorker({ spawnImpl: () => child })
      const handle = await worker.start(makeSpec(), ctx)
      const startedAt = Date.now()
      const stopPromise = worker.stop(handle, 'budget cap')
      // Let stop() send SIGTERM and arm its timer.
      await new Promise<void>((r) => setImmediate(r))
      assert.deepEqual(child.signals, ['SIGTERM'], 'SIGTERM must be sent before grace elapses')
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
        child.signals,
        ['SIGTERM', 'SIGKILL'],
        'SIGKILL must be sent after grace when SIGTERM was ignored',
      )
      const ev = await drainTerminal(worker, handle)
      assert.equal(ev.kind, 'failed')
      const failed = ev as Extract<WorkerEvent, { kind: 'failed' }>
      assert.equal(failed.terminationMode, 'sigkill')
    } finally {
      mock.timers.reset()
    }
  })

  it('stop() called after stream() has already terminated naturally → resolves immediately, no signal sent', async () => {
    // Use the simple fakeSpawn (which pre-buffers stdout via Readable.from) so
    // the worker sees a clean exit-0 + valid envelope and reaches state
    // 'complete' before stop() is called. The controllable child's manual
    // push() pattern races against the close emit and is overkill here.
    const envelope = { type: 'result', subtype: 'success', is_error: false, result: 'OK' }
    let killCount = 0
    const spawnImpl: SpawnFn = () => {
      const c = fakeChild({ stdout: JSON.stringify(envelope), exitCode: 0 })
      c.kill = (() => {
        killCount++
        return true
      }) as ChildProcess['kill']
      return c
    }
    const worker = new ClaudeCodeWorker({ spawnImpl })
    const handle = await worker.start(makeSpec(), ctx)
    const ev = await drainTerminal(worker, handle)
    assert.equal(ev.kind, 'complete')
    // State is now 'complete'. stop() must take the fast path.
    await worker.stop(handle, 'too late')
    assert.equal(killCount, 0, 'no signal should be sent after natural termination')
  })

  it('stop() called mid-spawn (no pid) → resolves once spawn settles, no error on spawn failure', async () => {
    const child = controllableChild({ pid: null })
    const worker = new ClaudeCodeWorker({ spawnImpl: () => child })
    const handle = await worker.start(makeSpec(), ctx)
    const stopPromise = worker.stop(handle, 'never started')
    // Simulate spawn failure landing after stop() was called.
    queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')))
    await stopPromise
    assert.deepEqual(
      child.signals,
      [],
      'no kill() should be issued when pid is unknown — wait for spawn to settle instead',
    )
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
  it('happy path: spawns claude -p --bare and returns parsed JSON result', async () => {
    const worker = new ClaudeCodeWorker()
    const ctx: WorkerContext = { env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! } }
    const handle = await worker.start(makeSpec(), ctx)
    let terminal: { kind: string; reason?: string; result?: unknown } | null = null
    for await (const event of worker.stream(handle)) {
      if (event.kind === 'complete' || event.kind === 'failed') {
        terminal = event as typeof terminal
        break
      }
    }
    assert.ok(terminal, 'stream must produce a terminal event')
    assert.equal(
      terminal!.kind,
      'complete',
      `expected complete, got failed: ${(terminal as { reason?: string }).reason}`
    )
    const result = (terminal as { result: { is_error?: boolean } }).result
    assert.equal(typeof result, 'object')
    assert.equal(result.is_error, false, 'claude reported an API error; key invalid or quota hit?')
  })
})
