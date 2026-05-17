import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import type {
  SessionHandle,
  TaskSpec,
  WorkerAgent,
  WorkerCapabilities,
  WorkerContext,
  WorkerEvent,
  WorkerStatusReport,
} from './types.ts'

export const MISSING_API_KEY_MESSAGE =
  'ClaudeCodeWorker requires ANTHROPIC_API_KEY in the daemon process environment ' +
  'before instantiation. See ADR-0002: the worker tier is API-key-only and the ' +
  'subprocess MUST NOT fall back to ~/.claude/.credentials.json or the OS keychain.'

export type SpawnPlan = {
  command: string
  args: string[]
  options: SpawnOptions
}

// Resolves the API key for a single start() call. WorkerContext.env wins when
// it carries a non-empty ANTHROPIC_API_KEY; empty-string or absent falls back
// to the constructor-captured key so callers can't accidentally scrub the
// credential by passing an empty override.
export function resolveApiKey(
  ctx: WorkerContext | null | undefined,
  fallback: string,
): string {
  const override = ctx?.env?.ANTHROPIC_API_KEY
  if (typeof override === 'string' && override.length > 0) return override
  return fallback
}

// Pure builder for the subprocess invocation. Exported so the regression test
// can assert on args (specifically --bare presence) without spawning anything.
export function buildSpawnPlan(spec: TaskSpec, apiKey: string): SpawnPlan {
  const args = ['-p', '--bare', '--output-format', 'json', spec.description]
  // No detached: true — the child stays in the daemon's process group so it
  // dies with the daemon. Orphaned workers would keep billing against the API
  // key with no supervisor to stop them.
  const options: SpawnOptions = {
    cwd: spec.workingDirectory ?? undefined,
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: apiKey,
      // Defense in depth: scrub shadow auth and provider-routing env that
      // could otherwise redirect or override the injected key via Claude Code
      // code paths --bare does not cover.
      CLAUDE_CODE_OAUTH_TOKEN: '',
      CLAUDE_CODE_USE_BEDROCK: '',
      CLAUDE_CODE_USE_VERTEX: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
  return { command: 'claude', args, options }
}

type Session = {
  child: ChildProcess
  startedAt: number
  lastEventAt: number
  state: WorkerStatusReport['state']
  reason: string | null
  // Resolves when the subprocess closes. Stream/status read from this.
  resolved: Promise<{ exitCode: number; stdout: string; stderr: string }>
}

// child_process.spawn is preferred over execFile here: execFile buffers stdout
// into a 1 MB default that an --output-format json result can plausibly exceed
// once tool-call payloads are folded in, and spawn keeps the door open for a
// future move to --output-format stream-json without re-plumbing.
export class ClaudeCodeWorker implements WorkerAgent {
  readonly #apiKey: string
  readonly #sessions = new Map<SessionHandle, Session>()

  constructor() {
    const key = process.env.ANTHROPIC_API_KEY
    if (key == null || key.length === 0) {
      throw new Error(MISSING_API_KEY_MESSAGE)
    }
    this.#apiKey = key
  }

  capabilities(): WorkerCapabilities {
    return {
      workerType: 'claude-code',
      modelId: 'claude-opus-4-7',
      maxContextTokens: 200_000,
      costPerMillionInputTokens: 1500,
      costPerMillionOutputTokens: 7500,
      supportsStreaming: false,
      supportsToolUse: true,
      declaredLanguages: null,
      protocolVersion: 1,
    }
  }

  async start(spec: TaskSpec, ctx: WorkerContext): Promise<SessionHandle> {
    const apiKey = resolveApiKey(ctx, this.#apiKey)
    const plan = buildSpawnPlan(spec, apiKey)
    const child = spawn(plan.command, plan.args, plan.options)

    const handle: SessionHandle = `claude-code:${child.pid ?? 'nopid'}:${randomUUID()}`

    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })

    const resolved = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
      (resolve) => {
        child.on('close', (code) => {
          resolve({ exitCode: code ?? -1, stdout, stderr })
        })
        child.on('error', (err) => {
          resolve({ exitCode: -1, stdout, stderr: stderr + String(err) })
        })
      }
    )

    const session: Session = {
      child,
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      state: 'running',
      reason: null,
      resolved,
    }
    this.#sessions.set(handle, session)

    void resolved.then(({ exitCode, stderr: errOut }) => {
      session.lastEventAt = Date.now()
      if (session.state === 'cancelled') return
      if (exitCode === 0) {
        session.state = 'complete'
      } else {
        session.state = 'failed'
        session.reason = errOut.trim() || `claude subprocess exited with code ${exitCode}`
      }
    })

    return handle
  }

  async status(handle: SessionHandle): Promise<WorkerStatusReport> {
    const session = this.#requireSession(handle)
    return {
      state: session.state,
      reason: session.reason,
      lastEventAt: session.lastEventAt,
    }
  }

  async *stream(handle: SessionHandle): AsyncIterable<WorkerEvent> {
    const session = this.#requireSession(handle)
    const { exitCode, stdout, stderr } = await session.resolved
    const at = Date.now()
    if (exitCode === 0) {
      let parsed: unknown
      try {
        parsed = JSON.parse(stdout)
      } catch (err) {
        yield {
          kind: 'failed',
          at,
          reason: `unparseable subprocess stdout: ${(err as Error).message}`,
          recoverable: false,
        }
        return
      }
      yield { kind: 'complete', at, partial: false, result: parsed }
    } else {
      yield {
        kind: 'failed',
        at,
        reason: stderr.trim() || `claude subprocess exited with code ${exitCode}`,
        recoverable: false,
      }
    }
  }

  async stop(handle: SessionHandle, reason: string): Promise<void> {
    const session = this.#requireSession(handle)
    if (session.state !== 'running' && session.state !== 'starting') return
    session.state = 'cancelled'
    session.reason = reason
    const pid = session.child.pid
    if (pid != null) {
      // Positive pid — signal just the child. The child is in the daemon's
      // process group (no detached: true), so signalling -pid here would
      // signal the daemon itself.
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* child already gone */
      }
    }
    await session.resolved
  }

  #requireSession(handle: SessionHandle): Session {
    const s = this.#sessions.get(handle)
    if (!s) throw new Error(`Unknown session handle: ${handle}`)
    return s
  }
}
