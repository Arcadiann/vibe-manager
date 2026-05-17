# ADR-0001: WorkerAgent Interface Contract

- Status: Proposed
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

The `WorkerAgent` interface has five methods and one capability struct. All methods are async. All return values are serializable so the contract survives a future move out-of-process.

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
- `stop` requests cleanup. Best-effort, with a contract: workers SHOULD stop within `STOP_GRACE_MS` (default 10s) or the orchestrator considers them leaked.

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
  | { kind: 'tokens'; at: number; inputTokens: number; outputTokens: number }
  | { kind: 'blocked'; at: number; reason: string; needs: string }
  | { kind: 'complete'; at: number; partial: boolean; result: unknown }
  | { kind: 'failed'; at: number; reason: string; recoverable: boolean }
```

- Workers MUST emit at least one event per `HEARTBEAT_INTERVAL_MS` (default 30s). If not, the orchestrator considers the worker zombied and calls `stop()`.
- The stream MUST terminate exactly once, by emitting either `complete` or `failed`, OR by closing the iterator without either (which the orchestrator treats as `failed` with synthetic reason `stream_closed_without_terminal`).
- `tokens` events are how the orchestrator updates `tasks.tokens_spent_cents`. Workers that don't have token granularity emit a single `tokens` event at completion.

### Error semantics

| Failure mode | Detection | Orchestrator response |
|---|---|---|
| **Crash** (process dies) | Stream closes without `complete` or `failed` | Synthetic `failed` event written to `events`, `tasks.status = failed`, `error.reason = stream_closed_without_terminal`. Retry per orchestrator policy. |
| **Hang / zombie** | No event for `HEARTBEAT_INTERVAL_MS * 3` | Orchestrator calls `stop()`. Records as `failed` with reason `zombie`. |
| **Timeout** | `Date.now() - startedAt > timeoutMs` | Orchestrator calls `stop()`. Records as `timed_out`. |
| **Garbage output** | Not the worker's job to detect. | Orchestrator validates against `successCriteria` post-hoc; treats as `failed` if validation rejects. |
| **Partial completion** | Worker emits `complete` with `partial: true` | Treated as `complete` for accounting, but flagged in `tasks.result.partial`. Manager Agent decides whether to re-task. |
| **Recoverable failure** | Worker emits `failed` with `recoverable: true` | Retry without escalation; non-recoverable failures escalate after N attempts. |

The contract is: **the worker reports what it knows; the orchestrator decides what it means.** Workers don't decide whether they should be retried, escalated, or replaced.

## How `ClaudeCodeWorker` satisfies the interface

- **Construction.** Takes a path to a base repo, a Conductor binary path, and configuration.
- **`capabilities()`.** Returns the configured Claude model ID, max context derived from a static table, and cost from the same table. `protocolVersion` starts at 1.
- **`start()`.** Creates a Conductor worktree, writes `TaskSpec` to a known location inside the worktree, spawns `claude` as a subprocess with structured-output flags. Returns a session handle (e.g., `claude-code:<pid>:<uuid>`).
- **`stream()`.** Tails the subprocess's structured stdout, parses each line into a `WorkerEvent`. Anything that doesn't parse becomes a `log` event at `warn`. Emits a synthetic `heartbeat` if no upstream event in 25s.
- **`status()`.** Checks process liveness and last-event timestamp.
- **`stop()`.** Sends SIGTERM, waits `STOP_GRACE_MS`, then SIGKILL. Cleans up the worktree (or marks it for reaping; see M3 open question).

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

5. **Workers as long-lived agents that accept multiple tasks over their lifetime.** Rejected: one-task-per-session is simpler, matches how Claude Code subprocesses naturally work, and avoids state leakage between unrelated tasks. We can add session reuse later if startup cost dominates (it doesn't, today).

## Claude-specific behavior to call out (so we don't smuggle it in)

These are properties of `ClaudeCodeWorker` that other workers might NOT share. The interface accommodates the variation:

- Claude Code emits explicit `tool_call` / `tool_result` events. Other workers may not — those would emit `log` events instead, or coarse `progress`. The orchestrator MUST NOT assume every worker emits structured tool calls.
- Claude Code reports token usage continuously. Other workers may only report at completion. The interface allows either by leaving emission frequency unspecified, only requiring `tokens` events exist.
- Claude Code runs in a Conductor worktree by convention. Other workers may not use Conductor. `TaskSpec.workingDirectory` is a hint, not a contract.
- Claude Code's `partial: true` semantics map to "I stopped at the token cap with useful work done." Other workers may interpret partial differently; `tasks.result.partial` is a hint to the Manager Agent, not a typed promise.

## Open questions

Flagged, not silently decided.

1. **Stream transport.** In-process `AsyncIterable<WorkerEvent>` works for v1 (orchestrator + worker share a process). When workers go out-of-process (cloud), do we go file-tail, gRPC stream, or something else? Pick when forced.
2. **`stop()` guarantee strength.** Currently "best-effort within `STOP_GRACE_MS`." Should we promise stronger termination (e.g., process group kill on Unix) at the interface level, or leave that to each implementation?
3. **Capability sync vs. async.** `capabilities()` is synchronous now. If a future worker needs to query a backend to know its model (e.g., the user-configured Cursor account's tier), we'd have to break this. Acceptable risk vs. complicating the orchestrator now?
4. **Streaming back-pressure.** What happens when the orchestrator can't consume events fast enough? Drop heartbeats? Buffer? Block the worker? Probably block; flagging.
5. **Worker self-restart.** If a worker detects an internally recoverable condition (e.g., rate limit), can it pause and retry inside one `start()` call, or must it `failed(recoverable: true)` and let the orchestrator re-task? Current proposal: prefer the latter for observability, but allow brief internal retries for transient API errors.
6. **Schema versioning of `WorkerEvent`.** `protocolVersion` is in `capabilities()`, but we haven't decided what the orchestrator does on a mismatch. Refuse to use the worker? Downgrade-and-warn? Defer until we change the protocol.
