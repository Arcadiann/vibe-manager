import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'

// Constructor-injected spawn for the parse-path tests in issue #17 and beyond.
// Picked function-pointer-via-constructor over a module-level mutable export
// because (a) it keeps test state local to the worker instance under test —
// no shared mutable module state to reset between tests — and (b) the
// WorkerAgent interface is unaffected: the constructor is implementation-
// private, callers still do `new ClaudeCodeWorker()` with no args.
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

export type ClaudeCodeWorkerOptions = {
  spawnImpl?: SpawnFn
}

import type {
  SessionHandle,
  TaskSpec,
  WorkerAgent,
  WorkerCapabilities,
  WorkerContext,
  WorkerEvent,
  WorkerStatusReport,
} from './types.ts'

// Grace window between SIGTERM and SIGKILL inside stop(). Matches ADR-0001
// §"Lifecycle" (10s default): long enough for a well-behaved subprocess to
// flush stdout, write final tokens, and exit cleanly; short enough that a
// hung child can't deadlock the orchestrator's stop path or daemon shutdown.
// Not configurable per call in this PR — single project-wide default until
// orchestrator design surfaces a real per-task tuning requirement.
export const STOP_GRACE_MS = 10_000

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

// Explicit allowlist of env vars the worker subprocess is permitted to inherit
// from the daemon's process.env. Everything else — including the entire
// CLAUDE_CODE_* and ANTHROPIC_* namespaces — is dropped on the floor.
//
// Per-entry justification:
//   PATH    — needed to locate `claude` and any tools the agent invokes.
//   HOME    — `claude --bare` still reads $HOME/.claude/settings.json for
//             non-auth settings; missing $HOME breaks resolution.
//   USER, LOGNAME — git commit authorship and various tools' shell prompts.
//   SHELL   — Bash tool inside Claude Code resolves the shell to invoke from
//             this; absence forces /bin/sh which surprises users.
//   LANG, LC_ALL — locale; absence yields garbled UTF-8 in tool output.
//   TMPDIR  — child writes scratch files (worktree state, scrubbed prompts).
//   TZ      — timestamps in log/event payloads.
//
// Explicitly NOT in the allowlist, and why:
//   - All CLAUDE_CODE_* and ANTHROPIC_*: the worker injects the one credential
//     it needs (ANTHROPIC_API_KEY below). Inheriting any of these would
//     reopen issue #8 — endpoint redirection (ANTHROPIC_BASE_URL,
//     CLAUDE_CODE_API_BASE_URL), provider switching (CLAUDE_CODE_USE_FOUNDRY,
//     USE_ANTHROPIC_AWS, USE_MANTLE, USE_CCR_V2), alt auth tokens
//     (ANTHROPIC_AUTH_TOKEN, OAUTH_REFRESH_TOKEN, SESSION_ACCESS_TOKEN,
//     CUSTOM_OAUTH_URL, *_FILE_DESCRIPTOR), org/scope retargeting
//     (ANTHROPIC_ORGANIZATION_ID, PROFILE, SCOPE, SERVICE_ACCOUNT_ID,
//     FEDERATION_RULE_ID, CONFIG_DIR), header injection
//     (ANTHROPIC_CUSTOM_HEADERS), model/billing override (ANTHROPIC_MODEL
//     and the DEFAULT_*_MODEL family, SMALL_FAST_MODEL, CUSTOM_MODEL_OPTION,
//     BETAS, CLAUDE_CODE_SUBSCRIPTION_TYPE, MAX_OUTPUT_TOKENS,
//     MAX_CONTEXT_TOKENS).
//   - 3P provider credentials (AWS_BEARER_TOKEN_BEDROCK, AWS_* generally,
//     GOOGLE_APPLICATION_CREDENTIALS, ANTHROPIC_FOUNDRY_API_KEY, etc.):
//     same risk — would let the spawned `claude` route spend through a
//     non-Anthropic backend with non-Anthropic creds, bypassing both the
//     injected key and the per-key spend cap from ADR-0002.
//   - NODE_OPTIONS, NODE_PATH: can inject `--inspect` debugger ports or
//     `--require` preload scripts into the child node runtime that backs
//     `claude`; arbitrary code execution surface.
//   - HTTP_PROXY, HTTPS_PROXY, NO_PROXY: standard tooling honors these and
//     would route Anthropic API traffic through an attacker-controlled proxy,
//     exfiltrating the injected key on the first request. Revisit if the
//     dogfood phase ever needs to run behind a corporate proxy — at that
//     point introduce an explicit per-worker proxy config rather than
//     environment inheritance.
const WORKER_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'TMPDIR', 'TZ',
] as const

// Build the env for the worker subprocess from scratch (NOT from process.env).
// Copies only the keys in WORKER_ENV_ALLOWLIST that are actually defined on
// the parent, then sets the injected API key. Absent allowlist keys are
// omitted (not padded with empty strings) so the child sees the same shape
// it would if the daemon's environment didn't define them.
export function buildSpawnEnv(apiKey: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of WORKER_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  env.ANTHROPIC_API_KEY = apiKey
  return env
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
    env: buildSpawnEnv(apiKey),
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
  // In-flight stop() promise — used to dedupe concurrent stop() calls so a
  // second caller gets the same promise rather than starting a second
  // termination sequence.
  stopPromise?: Promise<void>
  // Recorded by stop() once the termination outcome is known. Stream() reads
  // this onto the emitted `failed` event so the orchestrator can tell a
  // graceful exit from a forced one.
  terminationMode?: 'sigterm' | 'sigkill'
}

// child_process.spawn is preferred over execFile here: execFile buffers stdout
// into a 1 MB default that an --output-format json result can plausibly exceed
// once tool-call payloads are folded in, and spawn keeps the door open for a
// future move to --output-format stream-json without re-plumbing.
export class ClaudeCodeWorker implements WorkerAgent {
  readonly #apiKey: string
  readonly #spawn: SpawnFn
  readonly #sessions = new Map<SessionHandle, Session>()

  constructor(opts: ClaudeCodeWorkerOptions = {}) {
    const key = process.env.ANTHROPIC_API_KEY
    if (key == null || key.length === 0) {
      throw new Error(MISSING_API_KEY_MESSAGE)
    }
    this.#apiKey = key
    this.#spawn = opts.spawnImpl ?? spawn
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
    const child = this.#spawn(plan.command, plan.args, plan.options)

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
      // Closes #17: subprocess exit 0 is NOT the same as task success when
      // claude --output-format json wraps API/tool errors in an envelope with
      // is_error: true (rate limit, 401, content filter, tool-loop give-up).
      // The envelope shape is { type, subtype, is_error, result, ... }; the
      // human-readable error message lives in `result` when is_error is true.
      // Anything that isn't a plain object with a boolean is_error is treated
      // as a malformed envelope and alarmed rather than passed through —
      // silent success-when-actually-failed is the worst possible outcome.
      const envelope = parsed as { is_error?: unknown; result?: unknown } | null
      const isError = envelope != null && typeof envelope === 'object'
        ? envelope.is_error
        : undefined
      if (typeof isError !== 'boolean') {
        yield {
          kind: 'failed',
          at,
          reason: 'subprocess result envelope missing boolean is_error field',
          recoverable: false,
          payload: parsed,
        }
        return
      }
      if (isError) {
        const errText = typeof envelope!.result === 'string' && envelope!.result.length > 0
          ? envelope!.result
          : 'subprocess reported is_error without error text'
        yield {
          kind: 'failed',
          at,
          reason: errText,
          // recoverable: false is conservative — escalate by default rather
          // than retry-loop on a quota/auth/policy error. Per-error-type
          // classification can be layered in later without breaking this
          // contract.
          recoverable: false,
          payload: parsed,
        }
        return
      }
      yield { kind: 'complete', at, partial: false, result: parsed }
    } else {
      const failed: Extract<WorkerEvent, { kind: 'failed' }> = {
        kind: 'failed',
        at,
        reason: stderr.trim() || `claude subprocess exited with code ${exitCode}`,
        recoverable: false,
      }
      if (session.terminationMode) failed.terminationMode = session.terminationMode
      yield failed
    }
  }

  stop(handle: SessionHandle, reason: string): Promise<void> {
    const session = this.#requireSession(handle)
    // Concurrent stop() callers get the same promise — no second termination
    // sequence is started. Checked first so the second call doesn't hit the
    // state guard below (state is already 'cancelled' by the time we got
    // here). Identity equality is intentional so callers can dedupe by
    // reference.
    if (session.stopPromise) return session.stopPromise
    // Idempotent for already-terminal sessions (complete/failed/timed_out).
    if (session.state !== 'running' && session.state !== 'starting') {
      return Promise.resolve()
    }
    session.state = 'cancelled'
    session.reason = reason
    session.stopPromise = this.#runStopSequence(session)
    return session.stopPromise
  }

  async #runStopSequence(session: Session): Promise<void> {
    const child = session.child
    // Already exited (race: 'close' fired before stop() ran, or child died on
    // its own). Nothing to signal.
    if (child.exitCode !== null || child.signalCode !== null) return
    // Mid-spawn: pid not yet assigned. The child either spawns successfully
    // (we'd want to signal, but that path is exotic and not what the test
    // matrix covers) or fails outright. In both cases the resolved promise
    // will settle when spawn completes/errors; await that and exit clean.
    if (child.pid == null) {
      await session.resolved
      return
    }
    // Signals only the parent PID — process-group escalation is deliberately
    // out of scope for this PR. Tracked in issue #15.
    if (!this.#trySignal(child, 'SIGTERM')) {
      // child already gone between the exitCode check and now.
      return
    }
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
    })
    let timerId: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>((resolve) => {
      timerId = setTimeout(() => resolve('timeout'), STOP_GRACE_MS)
    })
    const winner = await Promise.race<'exit' | 'timeout'>([
      exited.then(() => 'exit' as const),
      timedOut,
    ])
    if (timerId !== undefined) clearTimeout(timerId)
    if (winner === 'exit') {
      session.terminationMode = 'sigterm'
      return
    }
    // SIGKILL is unblockable — exit is imminent. Await it so callers see
    // stop() resolve only after the child is actually gone.
    // Parent-PID signal only. ADR-0001:138 specifies SIGKILL to the entire process group;
    // process-group signaling is deferred to issue #15. The two PRs together satisfy the ADR contract.
    this.#trySignal(child, 'SIGKILL')
    await exited
    session.terminationMode = 'sigkill'
  }

  #trySignal(child: ChildProcess, signal: NodeJS.Signals): boolean {
    try {
      return child.kill(signal)
    } catch {
      return false
    }
  }

  #requireSession(handle: SessionHandle): Session {
    const s = this.#sessions.get(handle)
    if (!s) throw new Error(`Unknown session handle: ${handle}`)
    return s
  }
}
