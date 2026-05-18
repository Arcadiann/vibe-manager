import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'

import {
  ClaudeCodeWorker,
  MISSING_API_KEY_MESSAGE,
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
