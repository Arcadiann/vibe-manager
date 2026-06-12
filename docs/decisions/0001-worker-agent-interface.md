# ADR-0001: WorkerAgent Interface Contract

- Status: Accepted (2026-06-11 — two merged workers' worth of PRs conform to this contract; resolves #30. Drift issues #10, #16, #22 reconciled in the same pass.)
- Date: 2026-05-16
- Supersedes: —

## Context

The orchestrator never calls a model SDK directly. It calls a `WorkerAgent` — an abstraction over "a thing that can run a software task to completion." For v1, the only implementation is `ClaudeCodeWorker` (a subprocess wrapper around Claude Code in a Conductor worktree). For v2+, the same orchestrator must drive `CodexWorker`, `CursorWorker`, possibly `GeminiWorker`, and a future drag-and-drop hierarchy builder that lets customers compose workers they don't own.

This is the most architecturally consequential decision in v1 because:

- The orchestrator's task lifecycle, retry policy, budget accounting, and streaming all assume properties of this interface.
- Every other worker implementation is downstream of this contract.
- Getting it wrong means rewriting the orchestrator when we add a second worker — which defeats the whole point of having the abstraction.

The vision brief sketches the shape; this ADR makes it concrete enough to implement against.

## Decision

The `WorkerAgent` interface has five methods and one capability struct. Methods that perform I/O are async; `capabilities()` is synchronous and static (see below; resolves #10). All return values are serializable so the contract survives a future move out-of-process.

### Capability discovery (synchronous self-description)

```
type WorkerCapabilities = {
  workerType: string             // "claude-code", "codex", etc.
  modelId: string                // "claude-opus-4-7", "gpt-5", etc.
  maxContextTokens: number       // worker-reported, used by orchestrator for pre-flight checks
  costPerMillionInputTokens: number    // USD cents, integer
  costPerMillionOutputTokens: number   // USD cents, integer
  supportsStreaming: boolean
  supportsToolUse: boolean
  declaredLanguages: string[] | null   // null = generalist
  protocolVersion: number              // bump on any breaking change to event payloads
}

interface WorkerAgent {
  capabilities(): WorkerCapabilities
}
```

`capabilities()` is **synchronous and static** per worker instance. A worker that needs to query a backend to know its model/cost must do so at construction time, not at `capabilities()` call time. This keeps the orchestrator's planning logic simple.

### Lifecycle

```
type TaskSpec = {
  taskId: string                 // orchestrator-owned UUID
  title: string
  description: string
  successCriteria: string | null
  maxTokens: number | null       // soft cap; worker should stop when reached
  timeoutMs: number              // hard cap; orchestrator will call stop() at this point
  workingDirectory: string | null
}

type WorkerContext = {
  env: Record<string, string>    // environment variables the worker may read
  workspace?: WorkspaceHandle    // additive (ADR-0004): runtime-provisioned workspace,
                                 // supplied by the dispatcher when a WorkerRuntime is in play
  // Intentionally minimal. No memory, no events, no other-task references.
  // Anything else the worker needs comes via TaskSpec.description.
}

type SessionHandle = string      // opaque to the orchestrator

interface WorkerAgent {
  start(spec: TaskSpec, ctx: WorkerContext): Promise<SessionHandle>
  status(handle: SessionHandle): Promise<WorkerStatusReport>
  stream(handle: SessionHandle): AsyncIterable<WorkerEvent>
  stop(handle: SessionHandle, reason: string): Promise<void>
}
```

- `start` returns once the worker has accepted the task and is ready to stream — not when the task is complete. The orchestrator immediately calls `stream()` to consume events.
- `status` is a cheap, side-effect-free poll. Used for health checks and reconciliation after orchestrator restart.
- `stream` is the primary observation channel; see below.
- `stop` requests cleanup. The contract is stronger than best-effort: **after `stop()` resolves or after `STOP_GRACE_MS` (default 10s) elapses, whichever comes first, the worker MUST NOT emit any further `tokens` events.** Other event kinds (`log`, `failed`, terminal events emitted in-flight) may still arrive briefly, but token reporting must be authoritatively halted. Budget enforcement depends on this. Each implementation chooses how to honor it (for `ClaudeCodeWorker`, this is a process-group SIGKILL on Unix after the grace window).

### Status reports

```
type WorkerStatusReport = {
  state: 'starting' | 'running' | 'blocked' | 'complete' | 'failed' | 'timed_out' | 'cancelled'
  reason: string | null
  lastEventAt: number            // epoch ms; orchestrator uses to detect zombies
}
```

### Event stream

Workers emit a typed event stream. The taxonomy is small and deliberately not Claude-specific.

```
type WorkerEvent =
  | { kind: 'heartbeat'; at: number }
  | { kind: 'log'; at: number; level: 'info'|'warn'|'error'; message: string }
  | { kind: 'progress'; at: number; note: string }
  | { kind: 'tool_call'; at: number; toolCallId: string; tool: string; argsPreview: string }
  | { kind: 'tool_result'; at: number; toolCallId: string; ok: boolean; resultPreview: string }
  | { kind: 'file_edit'; at: number; path: string; bytesChanged: number }
  | { kind: 'tokens'; at: number; inputTokens: number; outputTokens: number;
      cacheCreationInputTokens?: number; cacheReadInputTokens?: number }
  | { kind: 'blocked'; at: number; reason: string; needs: string }
  | { kind: 'complete'; at: number; partial: boolean; result: unknown }
  | { kind: 'failed'; at: number; reason: string; recoverable: boolean;
      payload?: unknown; terminationMode?: 'sigterm' | 'sigkill' }
```

Additive field notes (shipped in `src/workers/types.ts`, reconciled here per #22):

- `tokens.cacheCreationInputTokens` / `tokens.cacheReadInputTokens` — optional cache counts from the underlying API's usage block. Workers that don't surface cache data omit them entirely rather than padding zeros (present-and-zero would falsely claim "we know there were zero cache hits").
- `failed.payload` — optional opaque diagnostic the worker captured at failure time (e.g. the parsed result envelope when a subprocess exited 0 but reported an in-envelope error). The orchestrator treats it as diagnostic data only.
- `failed.terminationMode` — set by workers that terminated the underlying resource themselves during `stop()`: `'sigterm'` means the child honored the graceful signal; `'sigkill'` means the grace window elapsed and force-termination was required. Absent on failures unrelated to `stop()`.

- Workers MUST emit at least one event per `HEARTBEAT_INTERVAL_MS` (default 30s). If not, the orchestrator considers the worker zombied and calls `stop()`.
- The stream MUST terminate exactly once, by emitting either `complete` or `failed`, OR by closing the iterator without either (which the orchestrator treats as `failed` with synthetic reason `stream_closed_without_terminal`).
- `tokens` events are how the orchestrator updates `tasks.tokens_spent_cents`. Token reporting frequency has two compliance paths, and workers MUST pick one:
  - **High-fidelity path.** Emit a `tokens` event at least every 10 seconds of running time OR every 5,000 output tokens, whichever comes first. The orchestrator can enforce per-task budget caps with near-real-time precision against these workers.
  - **Low-fidelity path.** Emit `tokens` events less often or only at completion. The orchestrator MUST mark the task with `budget_fidelity = 'low'`, MUST NOT terminate the worker mid-run on cap breach (the data isn't there to do so reliably), and reconciles the actual spend after the fact. Suitable for workers whose underlying systems don't surface incremental token counts.
- A worker declares its path implicitly by its event cadence; the orchestrator infers the path from the first 30 seconds of activity and from `complete` event data. Workers that intend the high-fidelity path but fail to emit at the required cadence are downgraded by the orchestrator to low-fidelity for the rest of the run and a `log` event at `warn` is recorded.
- **Back-pressure (resolved).** If the orchestrator consumes events more slowly than the worker produces them, the worker MUST block on the stream rather than buffer unboundedly, drop events, or fail. Heartbeats are not exempt — they queue behind real events. Workers SHOULD prefer coarser event granularity over selective dropping if back-pressure is sustained.

### Error semantics

| Failure mode | Detection | Orchestrator response |
|---|---|---|
| **Crash** (process dies) | Stream closes without `complete` or `failed` | Synthetic `failed` event written to `events`, `tasks.status = failed`, `error.reason = stream_closed_without_terminal`. Retry per orchestrator policy. |
| **Hang / zombie** | No event for `HEARTBEAT_INTERVAL_MS * 3` | Orchestrator calls `stop()`. Records as `failed` with reason `zombie`. |
| **Timeout** | `Date.now() - startedAt > timeoutMs` | Orchestrator calls `stop()`. Records as `timed_out`. |
| **Garbage output** | Not the worker's job to detect. | Orchestrator validates against `successCriteria` post-hoc; treats as `failed` if validation rejects. |
| **In-envelope error** (worker's underlying agent exits cleanly but reports failure in-band — e.g. Claude Code's `--output-format json` returning `is_error: true` on subprocess exit 0) | Worker parses the envelope and detects the authoritative failure signal. | Worker MUST emit `failed` (never `complete`), MAY classify `recoverable`, and SHOULD attach the parsed envelope as `failed.payload`. Distinct from "garbage output": garbage = the worker has no idea and validation is the orchestrator's job; envelope error = the worker has an authoritative signal and must surface it. Resolves #22; the silent-success variant of this bug was #17. |
| **Partial completion** | Worker emits `complete` with `partial: true` | Treated as `complete` for accounting, but flagged in `tasks.result.partial`. Manager Agent decides whether to re-task. |
| **Recoverable failure** | Worker emits `failed` with `recoverable: true` | Retry without escalation; non-recoverable failures escalate after N attempts. |
| **Budget cap breach (high-fidelity worker)** | `tokens_spent_cents` exceeds `token_budget_cents` mid-run | Orchestrator calls `stop()`; per the strengthened `stop()` contract, no further `tokens` events arrive after the grace window, so the cap is honored. Records as `failed` with reason `budget_exceeded`. |
| **Stop unresponsive** | `stop()` does not resolve and `STOP_GRACE_MS` elapses | Orchestrator treats the session as terminated for accounting purposes (no further `tokens` events accepted), records `failed` with reason `stop_timeout`, and surfaces a structured error. Implementation MUST force-terminate underlying resources (e.g., process-group SIGKILL) before this point. |
| **Protocol version mismatch** | Orchestrator finds `capabilities().protocolVersion` outside its supported range | Orchestrator refuses to call `start()` on this worker, writes a structured `worker_rejected` event to `vibe_manager.events` with the observed and supported versions, and surfaces the worker as unusable. Not a runtime failure mode but specified here for completeness. |

The contract is: **the worker reports what it knows; the orchestrator decides what it means.** Workers don't decide whether they should be retried, escalated, or replaced.

## How `ClaudeCodeWorker` satisfies the interface

Present-tense description of the merged implementation (`src/workers/claude-code-worker.ts`); rewritten per #16 — the original section described a worker that was never built.

- **Construction.** Zero-argument constructor (an options bag exists for test injection of the spawn function). Reads `ANTHROPIC_API_KEY` from the daemon's environment at construction and throws with a pointed message if absent (ADR-0002). It does not take a base-repo path or any Conductor configuration — workspace placement is not this layer's job (see ADR-0004).
- **`capabilities()`.** Returns a static table: configured Claude model ID, max context, cost per million tokens. `protocolVersion` is 1.
- **`start()`.** Builds the subprocess invocation as a pure exported function (testable without spawning), reconstructs the child env from an explicit allowlist plus the injected API key (#8/#9), passes the task prompt as a CLI argument (`claude -p --bare --output-format json <description>`), and spawns with `cwd = TaskSpec.workingDirectory`. Returns `claude-code:<pid>:<uuid>`. There is no TaskSpec file written into the workspace and no per-line streaming — see the fidelity note below.
- **`stream()`.** Accumulates the subprocess's full stdout and parses it once at close as a result envelope. Exit 0 with `is_error: true` maps to `failed` with the envelope attached as `payload` (#17/#23); a malformed envelope (missing boolean `is_error`) is alarmed as `failed`, never passed through as success. On a successful envelope it emits one `tokens` event derived from the `usage` block (forwarding optional cache fields, #13/#25) and then `complete`. Debounced synthetic `heartbeat`s fire when nothing else has been emitted for 25s (#11/#28); `lastEventAt` updates at every yield site (#12/#28).
- **`status()`.** Returns the session's tracked state, reason, and `lastEventAt` (lifecycle-transition test coverage is gapped — #20).
- **`stop()`.** Idempotent; concurrent callers share one termination promise. SIGTERM to the direct child, `STOP_GRACE_MS` (10s) grace, then SIGKILL, with the outcome recorded as `terminationMode` on the synthetic `failed` event (#14/#24). Today this signals **only the direct child** — process-group escalation is #15, and lands with ADR-0004's `GitWorktreeRuntime`, which owns process placement and performs group-first signaling. Worktree cleanup is likewise ADR-0004's `teardown()`/reaper, not the worker's job.
- **Token-reporting fidelity.** `ClaudeCodeWorker` is currently a **low-fidelity** path worker: exactly one `tokens` event at completion, derived from the result envelope. The high-fidelity path (incremental events via `--output-format stream-json`) is #26. A consequence worth naming: the worker cannot emit `blocked` or per-tool events mid-run today — whole-stdout-at-close parsing cannot observe mid-run state by construction.

**Remaining implementation gaps, tracked:** #15 (process-group stop — closes with ADR-0004's runtime), #18 (non-zero-exit stdout discarded from diagnostics), #19/#20 (test-coverage gaps), #26 (stream-json upgrade), #27 (envelope-shape integration pin).

## How a future `CodexWorker` satisfies the interface

A future worker only has to:

1. Implement `capabilities()` with its own model, cost, and context info.
2. Drive its underlying agent system (Codex CLI, API, whatever) and translate that system's events into the `WorkerEvent` taxonomy.
3. Map its termination conditions to the contract (crash → close stream; clean finish → `complete`; refused → `failed`).

The orchestrator does **not** change. Adding a new worker is a new class implementing one interface plus a registration entry.

## Non-goals

This interface deliberately does not promise:

- **Memory access.** Workers do not read from or write to `vibe_manager.memory`. The orchestrator decides what memories to inject into `TaskSpec.description`, and the orchestrator decides what to extract from completed tasks back into memory. Pushing this into the worker layer would couple worker implementations to our persistence stack.
- **Direct observability emission.** Workers don't write to `vibe_manager.events`, don't talk to metrics backends, don't emit OpenTelemetry. The orchestrator wraps the stream and observes externally. This keeps workers swappable without dragging our observability conventions into every worker codebase.
- **Inter-worker communication.** Workers don't know about each other. The Manager Agent (which is just another worker from the interface's perspective, modulo prompting) is the only coordination layer.
- **Cost accounting.** Workers report token usage; the orchestrator computes cost from `capabilities()` × `tokens` events. Workers do not need to know about USD.
- **Authentication / authorization.** Workers run with whatever credentials the orchestrator gave them via `WorkerContext.env`. They don't manage OAuth, key rotation, or scope.
- **Streaming output transport.** The interface says `AsyncIterable<WorkerEvent>`. Whether the underlying transport is in-process channels, a unix socket, or a file tail is an implementation detail of each worker.

## Alternatives considered

1. **Direct Anthropic SDK calls from the orchestrator.** Rejected: locks us into Claude immediately, deletes the entire premise of model-agnostic v2. Also requires the orchestrator to know about prompts, tool schemas, and conversation state at every call site.

2. **Generic "LLM provider" interface (chat-completions-shaped).** Rejected: workers are *sessions*, not single calls. A chat-completions API forces the orchestrator to drive turns, manage history, and decide when a task is "done" — which is exactly the work we want each worker to own.

3. **Event-bus-only contract (workers publish, orchestrator subscribes, no method calls).** Rejected: makes synchronous operations like "is this task done?" or "stop this task" awkward. The hybrid (methods + event stream) is strictly more honest about what's actually synchronous.

4. **Richer capabilities (e.g., `canEditFiles: boolean`, `supportsSubagents: boolean`).** Rejected for v1: speculative. We don't yet know which capability flags actually matter for orchestrator routing. Add fields when a real routing decision requires one.

5. **Pinning session lifetime in the contract (e.g., one-task-per-session or long-lived multi-task sessions).** Rejected: the contract is silent on session lifetime. `start()` accepts one `TaskSpec` and returns one `SessionHandle`; whether the underlying process/connection is fresh per call, pooled, or persistent across many `start()` calls is an implementation choice. `ClaudeCodeWorker` happens to spawn a fresh subprocess per `start()` (one-task-per-session in practice), but that is not promised by the interface and other workers may legitimately reuse a session for warm-startup or shared context.

## Claude-specific behavior to call out (so we don't smuggle it in)

These are properties of `ClaudeCodeWorker` that other workers might NOT share. The interface accommodates the variation:

- Claude Code *can* emit explicit `tool_call` / `tool_result` events (via stream-json; the current `ClaudeCodeWorker` does not yet — see #26). Other workers may never emit them — those would emit `log` events instead, or coarse `progress`. The orchestrator MUST NOT assume every worker emits structured tool calls.
- Claude Code *can* report token usage continuously and qualify for the high-fidelity token-reporting path; the merged `ClaudeCodeWorker` runs the **low-fidelity** path today (one `tokens` event at completion) and upgrades with #26. Other workers may only ever report at completion; the interface accommodates either explicitly (see Event stream above).
- Claude Code workers run in runtime-provisioned git worktrees per ADR-0004 (`WorkerRuntime`/`GitWorktreeRuntime`); Conductor is not in the runtime path. Other workers may use entirely different placement. `TaskSpec.workingDirectory` is a hint, not a contract — when a runtime is in play, the dispatcher supplies the authoritative `WorkerContext.workspace`.
- Claude Code's `partial: true` semantics map to "I stopped at the token cap with useful work done." Other workers may interpret partial differently; `tasks.result.partial` is a hint to the Manager Agent, not a typed promise.

## Open questions

Flagged, not silently decided.

1. **Stream transport.** In-process `AsyncIterable<WorkerEvent>` works for v1 (orchestrator + worker share a process). When workers go out-of-process (cloud), do we go file-tail, gRPC stream, or something else? Pick when forced.
2. **Capability sync vs. async.** `capabilities()` is synchronous now. If a future worker needs to query a backend to know its model (e.g., the user-configured Cursor account's tier), we'd have to break this. Acceptable risk vs. complicating the orchestrator now?
3. **Worker self-restart.** If a worker detects an internally recoverable condition (e.g., rate limit), can it pause and retry inside one `start()` call, or must it `failed(recoverable: true)` and let the orchestrator re-task? Current proposal: prefer the latter for observability, but allow brief internal retries for transient API errors.
