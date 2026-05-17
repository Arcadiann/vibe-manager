import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  ClaudeCodeWorker,
  MISSING_API_KEY_MESSAGE,
  buildSpawnPlan,
  resolveApiKey,
} from '../../src/workers/claude-code-worker.ts'
import type { TaskSpec, WorkerContext } from '../../src/workers/types.ts'

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

  it('spawn plan injects ANTHROPIC_API_KEY and scrubs CLAUDE_CODE_OAUTH_TOKEN', () => {
    const plan = buildSpawnPlan(makeSpec(), 'sk-ant-fake-test-key')
    const env = plan.options.env as Record<string, string>
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-fake-test-key')
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, '')
  })

  it('spawn plan does NOT write any credential file path into args', () => {
    const plan = buildSpawnPlan(makeSpec(), 'sk-ant-fake-test-key')
    const joined = plan.args.join(' ')
    assert.doesNotMatch(joined, /credentials\.json/)
    assert.doesNotMatch(joined, /\.claude\//)
  })

  it('spawn plan scrubs all shadow-auth and provider-routing env vars', () => {
    const plan = buildSpawnPlan(makeSpec(), 'sk-ant-fake-test-key')
    const env = plan.options.env as Record<string, string>
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, '')
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, '')
    assert.equal(env.CLAUDE_CODE_USE_VERTEX, '')
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
