# Advisor bootstrap

Single-file concatenation of every canonical context document a fresh advisor chat needs. The five source documents are pasted in full below, in order, each under a level-2 header naming its source. See the final "How to use this file" section for the intended workflow.

## advisor-context.md

# Advisor context

Canonical state-of-the-project handoff for the technical advisor. Read this first; it points at the ADRs and issues that hold the real detail.

## Project snapshot

Vibe Manager is a hierarchical multi-agent orchestrator for software development: a human operator describes a product vision, a Vision Agent translates that into ongoing direction for a Technical Manager Agent, the Technical Manager decomposes work and delegates to a fleet of Worker Agents running in parallel, results flow back up, and the human is pinged only when a decision affects vision or requires clarification beyond what the agents can resolve themselves. The v1 MVP scope is locked: the worker tier wraps Claude Code via Conductor worktrees, persistence is Postgres + pgvector on the existing Supabase project, the Vision Agent is a binary decision router (escalate/proceed) rather than a strategic thinker, and human escalations go out as Slack DMs. The build path is Version A (internal dogfood on the operator's paused matome.ai codebase, target acceptance is issue matome.ai#97 shipping end-to-end with the laptop in clamshell mode) followed by Version C (multi-tenant SaaS with customer-configured agent hierarchies). Version B is intentionally skipped.

## Architecture-of-record

The accepted architectural decisions, in order. The constraint each one imposes is the part that matters for downstream choices.

- **ADR-0001 — WorkerAgent Interface Contract** (status: Proposed; load-bearing in practice). Defines the five-method `WorkerAgent` interface (`capabilities`, `start`, `status`, `stream`, `stop`) plus the typed `WorkerEvent` taxonomy and the high-fidelity / low-fidelity token-reporting paths. **Constraint:** the orchestrator never touches a model SDK directly; every worker — Claude Code today, Codex/Cursor/Gemini later — speaks this exact event vocabulary, and the orchestrator alone decides what failures mean. Adding a new worker is a new class implementing one interface, not an orchestrator rewrite.
- **ADR-0002 — Worker Authentication via `ANTHROPIC_API_KEY`** (status: Accepted; supersedes the OAuth/subscription-credit billing rows in `docs/vision.md`). API key auth is the sole worker auth mechanism for v1; the key is delivered to the subprocess only through `WorkerContext.env` and must never be written to `~/.claude/.credentials.json`. **Constraint:** every worker token is billed at API-tier pricing from the first call (no Pro/Max credit cushion), spend control happens at org-cap + per-key-cap in the Claude Console, key rotation is the operator's job, and the A→C SaaS migration carries zero auth-layer rewrite because both versions are already on the same model.
- **ADR-0003 — Persistence Schema (`tasks`, `task_dependencies`, `memory`, `events`)** (status: Proposed; operator review pending — must not be marked Accepted until follow-ups #33–#38 resolve). Four tables in a dedicated `vibe_manager` schema, status vocabulary unified with ADR-0001's worker state machine (plus an orchestrator-only `'pending'`), `events.payload jsonb` audited losslessly against every current `WorkerEvent` variant, `memory.embedding` committed to `halfvec(3072)` matching `text-embedding-3-large` with HNSW indexing. **Constraint:** the schema fixes the embedding dimension on the column type (model swaps that change dim require a column migration, not just a re-embed), assumes a single orchestrator writer (no row-level concurrency control on `tasks`), and defaults `events` retention to 90 days. Explicit non-goals: ORM choice, migration tooling, RLS posture, multi-tenancy — each a future ADR.

## Worker tier status

The only orchestrator-facing surface that exists today. Everything above the worker tier (Manager Agent, Vision Agent, escalation routing, Postgres schema) is still on paper.

- **Files.**
  - `src/workers/types.ts` — `WorkerAgent` interface + all type definitions from ADR-0001 (capabilities, task spec, context, status report, event union). Includes an additive extension to the `tokens` event for optional `cacheCreationInputTokens` / `cacheReadInputTokens`, and an additive `terminationMode: 'sigterm' | 'sigkill'` field on `failed` events emitted by `stop()`.
  - `src/workers/claude-code-worker.ts` — `ClaudeCodeWorker` implementation: subprocess spawn with `--bare`, env allowlist + API-key injection, structured-stdout parsing into `WorkerEvent`s, bounded `stop()` with SIGTERM-then-SIGKILL grace, heartbeat emission, `lastEventAt` updates at every yield site, terminal-event mapping from the result envelope's `is_error` flag, and a `tokens` event derived from the result envelope's `usage` block.
  - `tests/workers/claude-code-worker.test.ts` — 37 tests in CI plus a guarded integration suite that runs against a real `claude` binary when `INTEGRATION_SKIP_REASON` is unset.

- **Interface signature** (from `src/workers/types.ts`):

  ```ts
  export interface WorkerAgent {
    capabilities(): WorkerCapabilities
    start(spec: TaskSpec, ctx: WorkerContext): Promise<SessionHandle>
    status(handle: SessionHandle): Promise<WorkerStatusReport>
    stream(handle: SessionHandle): AsyncIterable<WorkerEvent>
    stop(handle: SessionHandle, reason: string): Promise<void>
  }
  ```

- **Implemented.** `capabilities()` (static table); `start()` (spawn `claude -p --bare` with allowlisted env + API-key injection, no detach); `stream()` (parses result envelope, emits `tokens` from usage block, maps `is_error` to `failed`, emits heartbeats on idle, updates `lastEventAt` at every yield); `stop()` (idempotent SIGTERM → grace → SIGKILL with `terminationMode` on the synthetic `failed` event).

- **Stubbed / not yet present.** `status()` is implemented but its lifecycle-transition coverage is gapped (#20). `stream()`'s failure-path coverage is gapped (#19). `stop()` only signals the direct child; subprocesses Claude Code itself spawned can leak (#15). Incremental token reporting (the ADR-0001 high-fidelity path: ≥1 `tokens` event per 10s OR per 5k output tokens) is **not** implemented — today the worker emits exactly one `tokens` event at completion derived from the result envelope's usage block, which is the low-fidelity path. The stream-json upgrade is open as #26.

- **CI test count.** 37 unit tests in `tests/workers/claude-code-worker.test.ts`. Integration tests gated by environment.

## Issues open against the worker layer

Open only. Grouped by priority. No p1s are currently open against the worker tier — all four p1 worker bugs have been closed by the recent merged PRs.

**P2**

- **#15** — `stop()` signals only the direct child; subprocesses spawned by Claude Code leak. Type:bug. The current `stop()` honors the ADR-0001 grace contract for the immediate child, but Claude Code can spawn its own helpers and those escape SIGKILL. Process-group signaling is the fix; blocked on no design questions.
- **#19** — Test coverage gap: `stream()` failure paths and terminal-event contract. Type:test. Need explicit coverage for "stream closes without `complete` or `failed`" producing the synthetic-`failed` path the ADR mandates.
- **#20** — Test coverage gap: `stop()` and `status()` lifecycle transitions. Type:test. Companion to #19; exercises the full state machine on the implementation.

**P3**

- **#10** — ADR-0001 says "all methods are async" but the spec body defines `capabilities()` as synchronous. Doc-only drift; trivial edit but blocked on advisor confirmation that synchronous-capabilities is the intended semantics (the implementation already treats it that way).
- **#16** — ADR-0001 §"How `ClaudeCodeWorker` satisfies the interface" diverges from merged implementation. Doc-only drift accumulated as the implementation landed; needs a single follow-up PR to reconcile.
- **#18** — Non-zero subprocess exit discards stdout content from failure diagnostics. Low-impact UX bug; surface the captured stdout in the synthetic `failed` event's payload.
- **#21** — `WorkerCapabilities` has no field declaring required env / auth for future model-agnosticism. Type:feat. Today the orchestrator only knows what a worker needs by reading source. Blocked-on-orchestrator-design: the right shape depends on how the orchestrator's credential broker turns out, so we will not invent this field speculatively.
- **#22** — docs(ADR-0001): make `is_error` envelope semantics explicit for the `failed` event. Doc-only follow-up from #23/#17.
- **#26** — Worker: emit incremental `tokens` events via `--output-format stream-json`. Type:feat. The path from low-fidelity to high-fidelity token reporting; required before mid-run budget cap enforcement can be honored on Claude Code workers. Blocked-on-orchestrator-design only to the extent that the orchestrator's budget enforcer doesn't exist yet, so there's no consumer.
- **#27** — Worker: integration-verify usage envelope shape against live Claude Code CLI. Type:test. Pins the assumed envelope structure against a real CLI version so future Claude Code updates don't silently break parsing.

## Recently merged

Last nine PRs (the project is nine PRs old; this is the complete merged history, newest first):

- **#28 — feat(worker): heartbeats and `lastEventAt` at all event sites (closes #11, #12).** Worker now emits debounced `heartbeat` events while idle (preventing the orchestrator zombie detector from firing on long tasks) and updates `lastEventAt` at every `WorkerEvent` yield site (so `status()` reflects reality, not just subprocess close).
- **#25 — feat(worker): emit `tokens` event from result envelope usage block (closes #13).** Worker now derives one `tokens` event at completion from the Claude Code result envelope's `usage` block, forwarding optional cache-token fields. This is the low-fidelity token-reporting path per ADR-0001; #26 is the high-fidelity follow-up.
- **#24 — feat(worker): bounded `stop()` with SIGTERM grace and SIGKILL fallback (closes #14).** Implements ADR-0001's strengthened `stop()` contract: SIGTERM, wait `STOP_GRACE_MS`, SIGKILL the direct child, emit a synthetic `failed` event tagged with `terminationMode`. Idempotent across repeat calls.
- **#23 — fix(worker): map subprocess `is_error: true` to `failed` event (closes #17).** Exit-0-with-`is_error: true` was previously misclassified as `complete`; now it's `failed` with the envelope's error text or a synthetic reason. The silent-success bug that had to die before any orchestrator could trust the worker.
- **#9 — feat(worker): replace env scrub denylist with explicit allowlist (closes #8).** Worker subprocess env is now reconstructed from a known allowlist plus the injected `ANTHROPIC_API_KEY`; nothing else leaks through. Closes a security gap where blocklists missed billing-routing vars (`ANTHROPIC_BASE_URL`, `USE_FOUNDRY`, model-override flags, etc.).
- **#7 — ClaudeCodeWorker: API-key env injection.** First implementation of the ADR-0002 credential-delivery path: the daemon's `ANTHROPIC_API_KEY` is injected into the subprocess's env and into nowhere else.
- **#5 — Strip prompt-injection wrapper from `docs/vision.md` (closes #4).** Removed adversarial instruction text that had been wrapped around the vision brief by an earlier agent pass.
- **#3 — ADR-0002: worker auth via `ANTHROPIC_API_KEY` (closes #2).** Records the OAuth → API key auth decision and what it supersedes in `docs/vision.md`.
- **#1 — v1 planning: milestones, schema proposal, WorkerAgent ADR.** Initial scaffolding: ADR-0001 draft, milestone outline, and Postgres schema sketch.

## Working agreements with the advisor

The operator runs a parallel-workspace setup on top of Conductor and treats GitHub Issues as the source of truth — not markdown to-do files in the repo, not notes in chat. One open issue per workspace; if a workspace's investigation surfaces a second concern, that becomes a new issue rather than scope creep on the current PR. No stacked branches: every PR is off the current `origin/main`, the worktree must be clean before work starts, and the branch name itself is cosmetic and not enforced. Anything that touches architecture, the Postgres schema, or destructive operations gates on a plan-first review before code lands. The standard pipeline on a worker-tier PR is `/review` → `/qa` → `/ship`; parallel work is fine but only when the files don't overlap. Stop conditions in a workspace prompt are mandatory, not advisory — if a step says "STOP, report what's missing," the right move is to stop and report, not to invent the missing fact.

Tone: direct prose over bullet-heavy hedging, no flattery, no validation theater, push back when the operator is about to do something dumb. The operator's background is newsletter/lifecycle email marketing rather than traditional software engineering, so explanations should be honest about depth without padding caveats. Slack DMs are for vision-affecting escalations only; routine technical choices inside an approved approach do not surface to the human.

## Common failure modes the advisor watches for

- **Stop conditions firing on cosmetic branch-name mismatches.** Branch names are intentionally not load-bearing. A workspace whose branch name differs from a prompt's suggestion is not in a broken state; only the worktree-clean-off-main precondition is real.
- **Env-var leakage into worker subprocesses.** Per ADR-0002 and #8/#9, the subprocess env is an explicit allowlist plus the injected key. Any change that adds a passthrough variable is changing the security contract and should be challenged.
- **Silent-success bugs in result-envelope parsing.** #17 was the canonical instance: exit code 0 with `is_error: true` reported as `complete`. The class of bug — a malformed terminal mapped to the success path — is the worst kind because the orchestrator can't recover from data it never saw. New envelope fields and new CLI versions are the high-risk surfaces.
- **Orphan subprocesses from `detached: true`.** The current worker explicitly does not detach (regression-tested in CI). Any PR that flips this is reintroducing the zombie-process failure mode #15 is already trying to fully close.
- **ADR drift in agent-proposed implementations.** Multiple worker PRs landed implementations that diverged from ADR-0001's prose; #10, #16, #22 are the open doc-side reconciliations. An advisor reviewing a worker PR should compare against ADR-0001 directly rather than trusting a paraphrase in the PR body.
- **Scope creep where one PR addresses two issues.** The working agreement is one issue per workspace and one issue per PR. A PR that "happens to also fix" a second issue should be split; closing two issues with a single squash is acceptable only when the issues describe the same root cause (as #11 + #12 did in #28).

## What's next

No p1 issues are currently open against the worker tier. The immediate worker-tier queue is the three open p2s — #15 (process-group signaling so `stop()` no longer leaves Claude Code's helper subprocesses behind) and the two test-coverage gaps #19 and #20 — followed by the p3 cleanup: doc reconciliation (#10, #16, #22), failure-diagnostics surfacing (#18), and the stream-json incremental-tokens upgrade (#26) that promotes Claude Code workers from the low-fidelity to the high-fidelity token-reporting path. Beyond the worker tier, the next architectural beat is orchestrator design: task lifecycle, the Postgres schema for `tasks` / `memory` / `events`, the retry / escalation policy, and the budget enforcer that will consume the tokens stream once #26 lands. Several worker-tier issues (#21 in particular) are deliberately parked until the orchestrator's shape is clearer so we don't speculate on capability fields no orchestrator routing decision yet depends on.

## How to update this doc

Every PR that materially changes the architecture-of-record (new ADR accepted or superseded), the worker tier's implemented-vs-stubbed status, or the open-issue triage list should include a corresponding edit to this file as part of its diff. Treat it the same as updating a CHANGELOG: not optional, not a separate follow-up. Future workspace prompts should reference this doc at investigation step 1, alongside reading the relevant ADRs in full — it exists so that an advisor can pick up state in one read without replaying the project's chat history.

## vision.md

# Vibe Manager — Vision Brief

## What this is

Vibe Manager is a hierarchical multi-agent orchestrator for software development. A human operator describes a product vision; a Vision Agent translates that into ongoing direction for a Technical Manager Agent; the Technical Manager decomposes work and delegates to a fleet of Worker Agents running in parallel; results flow back up; the human is pinged only when a decision affects vision or requires clarification beyond what the agents can resolve themselves.

The product is being built by a solo founder who currently operates a parallel-sprint workflow on top of Claude Code + Conductor and wants to graduate from "active typist" to "reviewer of escalations." MVP is for the founder's own use on a paused production codebase (matome.ai). The longer arc is a cloud-hosted SaaS where customers configure their own agent hierarchies, models, and contexts via drag-and-drop.

## Strategic frame

The product exists in a well-funded competitive landscape (Devin, Cursor BG agents, Codex Web, Anthropic Agent Teams, Gastown, Ruflo, Multiclaude). The defensible position is the upper-right quadrant of the polish-vs-hierarchy matrix that nobody has filled: a polished, customizable, multi-tier orchestrator with real escalation routing. This is empty because the problem is hard — model reliability collapses at multi-tier delegation, and trust between human and orchestrator is fragile. Vibe Manager's bet is that the right answer is not a smarter vision agent but a well-designed *decision router* that knows what to escalate, plus mature reliability engineering on the worker tier.

The MVP exists primarily to (a) prove the founder's own dogfooding loop works on matome.ai and (b) generate ground truth about which abstractions are real versus premature before committing to a productized version.

## v1 acceptance criteria

The MVP is done when the founder can:

1. File a single real matome.ai issue (specifically: issue #97, Postgres integration testing for matome.ai) into Vibe Manager via a single command.
2. Walk away from the laptop (lid closed, clamshell mode).
3. Return to a reviewable pull request on the matome.ai repo with the work properly decomposed across the agent hierarchy.
4. Find Slack DMs in their inbox for any decisions that required vision-level input, with sufficient context to make each call in under five minutes.
5. Have spent no more than the configured monthly budget cap.

If all five hold for issue #97, v1 ships. If any fail, v1 is not done.

## Scope decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| **Build path** | Internal tool (A) → SaaS (C), in that order | Dogfood for 4–6 weeks before productizing to learn which abstractions are real |
| **Repo** | Standalone (new repo, not inside matome.ai) | Clean separation; necessary for eventual productization |
| **Worker tier (v1)** | Wrap Claude Code via Conductor worktrees | Leverage mature tooling; replace later when forced |
| **Worker interface** | Model-agnostic abstraction from day one | Enables future Codex/Gemini/Cursor workers without rewriting orchestrator |
| **Vision agent role** | Decision router, not strategic thinker | Realistic given current model reliability; matches what the founder actually wants |
| **Persistence** | Postgres + pgvector on existing Supabase project | Already deployed; survives the A→C transition unchanged |
| **Escalation channel** | Slack DM (with text/SMS as fallback) | Founder's preferred interrupt channel |
| **Escalation threshold** | Vision-affecting or clarification-required decisions; not access requests or routine technical choices | Matches founder's current pattern with human technical advisor |
| **MVP runtime** | Founder's laptop in clamshell mode | One user, no real cloud needed; cloud is a C decision |
| **Billing** | OAuth via Agent SDK, extra-usage fallback enabled, shared billing path with Conductor | Uses already-paid-for credits first, falls to pay-as-you-go cleanly |
| **Monthly spend cap** | $500/mo, hard cap in Claude Console | Adjustable; sized to force decisions about concurrency and context reuse |

## Architecture sketch

Three tiers of agents, three persistence stores, one human:

```
Human (escalations only) ──Slack DM──┐
                                      │
                                      ▼
                            ┌─────────────────────┐
                            │   Vision Agent      │  (decision router)
                            │   - reads vision    │
                            │   - reads progress  │
                            │   - decides escalate/proceed/redirect
                            └──────────┬──────────┘
                                       │ direction
                                       ▼
                            ┌─────────────────────┐
                            │ Technical Manager   │  (1, for MVP)
                            │ - decomposes work   │
                            │ - assigns to workers│
                            │ - synthesizes results
                            └──────────┬──────────┘
                                       │ tasks
                            ┌──────────┴──────────┐
                            ▼          ▼          ▼
                        ┌──────┐   ┌──────┐   ┌──────┐
                        │Worker│   │Worker│   │Worker│   (N, parallel)
                        │  +   │   │  +   │   │  +   │   each in a
                        │ wkt  │   │ wkt  │   │ wkt  │   Conductor worktree
                        └──────┘   └──────┘   └──────┘
```

State flows through three Postgres stores:

- **`tasks` table**: current work-in-flight, status, dependencies, parent/child relationships
- **`memory` table** (pgvector): semantic memory of past discoveries, lessons, codebase quirks, available to all agents on read
- **`events` table**: append-only audit log of every decision, delegation, escalation, and tool call; the source-of-truth replay for "why did this happen at 2am"

Code state lives in git via Conductor worktrees, atomic with task state through the events log.

## Worker interface contract (the abstraction that matters most)

The orchestrator never calls Claude Code directly. It calls a `WorkerAgent` interface:

```
WorkerAgent
  .start(task_id, context) → session_handle
  .status(session_handle) → {running, blocked, complete, failed}
  .stream_events(session_handle) → events
  .stop(session_handle) → cleanup
  .capabilities → {languages, max_context, cost_per_1k, model_id}
```

For v1, the only implementation is `ClaudeCodeWorker` (subprocess + Conductor worktree). For v2, additional implementations (`CodexWorker`, `CursorWorker`, etc.) can be added without orchestrator changes. The customer-facing drag-and-drop hierarchy builder consumes this interface.

## Decision router heuristics

The Vision Agent's only job is binary classification: escalate to human, or let the system proceed. Rough rubric for what the agent learns to classify:

**Escalate** when the proposed change would:

- Change product direction or user-facing behavior in a way not explicitly authorized by the original vision
- Reverse a previously documented decision (e.g., the CASA Tier 2 "no Inngest" choice)
- Touch security, auth, billing, or PII surfaces
- Require new external service contracts or API keys
- Exceed a per-task token budget cap (currently $20/task default, configurable)
- Encounter a blocker the Technical Manager can't resolve after N retries

**Do not escalate** for:

- Naming, formatting, style choices
- Routine access requests (the orchestrator grants its workers what they need)
- Minor technical implementation choices within an approved approach
- Anything explicitly delegated in the original task framing

The router itself is a Claude call with the task context, the proposed action, and the rubric. It outputs `{escalate: bool, reason: string, urgency: enum}` and routes accordingly.

## Out of scope for v1

Explicitly deferred:

- Drag-and-drop UI for hierarchy configuration (C-stage)
- Non-Claude worker implementations (C-stage)
- Multi-user, multi-tenant architecture (C-stage)
- Real cloud backend (C-stage; laptop is sufficient for one user)
- Customer auth/billing infrastructure (C-stage)
- Web dashboard (Postgres + Supabase Studio is the v1 dashboard)
- Nested hierarchies beyond Vision→Manager→Workers (the Agent Teams limitation; one tier of management is enough for v1)
- Cost optimization beyond hard caps (we'll learn what's worth optimizing from real usage)

## Open questions for first agent pass

These are flagged for the planning stage, not pre-decided:

1. Concrete Postgres schema for `tasks`, `memory`, `events` tables
2. How worker output streams back to the orchestrator (file-based, stdout parse, Conductor API if exposed)
3. How the vision agent reads "the vision" — static markdown file in the repo, structured prompt, or something more dynamic
4. Slack escalation message format (what context is enough for a 5-minute decision)
5. Failure recovery: what happens when a worker crashes mid-task or returns garbage
6. Concurrency policy: max parallel workers, how the manager throttles

## Founder context for the agents

The operator is a solo founder, currently full-time on Vibe Manager while matome.ai is paused pending CASA Tier 2 clearance. Background is newsletter/lifecycle email marketing, not traditional software engineering — comfortable with agentic workflows but expects the agents to handle implementation depth. Communication preference: direct, prose, minimal filler, honest pushback over validation. The agents should not over-explain, ask permission for routine technical choices, or pad responses with caveats.

## ADR-0001: Worker agent interface

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
  | { kind: 'tokens'; at: number; inputTokens: number; outputTokens: number }
  | { kind: 'blocked'; at: number; reason: string; needs: string }
  | { kind: 'complete'; at: number; partial: boolean; result: unknown }
  | { kind: 'failed'; at: number; reason: string; recoverable: boolean }
```

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
| **Partial completion** | Worker emits `complete` with `partial: true` | Treated as `complete` for accounting, but flagged in `tasks.result.partial`. Manager Agent decides whether to re-task. |
| **Recoverable failure** | Worker emits `failed` with `recoverable: true` | Retry without escalation; non-recoverable failures escalate after N attempts. |
| **Budget cap breach (high-fidelity worker)** | `tokens_spent_cents` exceeds `token_budget_cents` mid-run | Orchestrator calls `stop()`; per the strengthened `stop()` contract, no further `tokens` events arrive after the grace window, so the cap is honored. Records as `failed` with reason `budget_exceeded`. |
| **Stop unresponsive** | `stop()` does not resolve and `STOP_GRACE_MS` elapses | Orchestrator treats the session as terminated for accounting purposes (no further `tokens` events accepted), records `failed` with reason `stop_timeout`, and surfaces a structured error. Implementation MUST force-terminate underlying resources (e.g., process-group SIGKILL) before this point. |
| **Protocol version mismatch** | Orchestrator finds `capabilities().protocolVersion` outside its supported range | Orchestrator refuses to call `start()` on this worker, writes a structured `worker_rejected` event to `vibe_manager.events` with the observed and supported versions, and surfaces the worker as unusable. Not a runtime failure mode but specified here for completeness. |

The contract is: **the worker reports what it knows; the orchestrator decides what it means.** Workers don't decide whether they should be retried, escalated, or replaced.

## How `ClaudeCodeWorker` satisfies the interface

- **Construction.** Takes a path to a base repo, a Conductor binary path, and configuration.
- **`capabilities()`.** Returns the configured Claude model ID, max context derived from a static table, and cost from the same table. `protocolVersion` starts at 1.
- **`start()`.** Creates a Conductor worktree, writes `TaskSpec` to a known location inside the worktree, spawns `claude` as a subprocess with structured-output flags. Returns a session handle (e.g., `claude-code:<pid>:<uuid>`).
- **`stream()`.** Tails the subprocess's structured stdout, parses each line into a `WorkerEvent`. Anything that doesn't parse becomes a `log` event at `warn`. Emits a synthetic `heartbeat` if no upstream event in 25s.
- **`status()`.** Checks process liveness and last-event timestamp.
- **`stop()`.** Sends SIGTERM to the subprocess, waits `STOP_GRACE_MS`, then SIGKILL to the entire process group (to catch any subprocesses Claude Code itself spawned). This is how `ClaudeCodeWorker` honors the contract's "no further `tokens` events after grace" requirement. Cleans up the worktree (or marks it for reaping; see M3 open question).

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

- Claude Code emits explicit `tool_call` / `tool_result` events. Other workers may not — those would emit `log` events instead, or coarse `progress`. The orchestrator MUST NOT assume every worker emits structured tool calls.
- Claude Code reports token usage continuously and qualifies for the high-fidelity token-reporting path. Other workers may only report at completion and run in the low-fidelity path; the interface accommodates either explicitly (see Event stream above).
- Claude Code runs in a Conductor worktree by convention. Other workers may not use Conductor. `TaskSpec.workingDirectory` is a hint, not a contract.
- Claude Code's `partial: true` semantics map to "I stopped at the token cap with useful work done." Other workers may interpret partial differently; `tasks.result.partial` is a hint to the Manager Agent, not a typed promise.

## Open questions

Flagged, not silently decided.

1. **Stream transport.** In-process `AsyncIterable<WorkerEvent>` works for v1 (orchestrator + worker share a process). When workers go out-of-process (cloud), do we go file-tail, gRPC stream, or something else? Pick when forced.
2. **Capability sync vs. async.** `capabilities()` is synchronous now. If a future worker needs to query a backend to know its model (e.g., the user-configured Cursor account's tier), we'd have to break this. Acceptable risk vs. complicating the orchestrator now?
3. **Worker self-restart.** If a worker detects an internally recoverable condition (e.g., rate limit), can it pause and retry inside one `start()` call, or must it `failed(recoverable: true)` and let the orchestrator re-task? Current proposal: prefer the latter for observability, but allow brief internal retries for transient API errors.

## ADR-0002: Worker auth via API key

# ADR-0002: Worker Authentication via ANTHROPIC_API_KEY

- Status: Accepted
- Date: 2026-05-17
- Supersedes: —

## Context

The v1 worker tier wraps Claude Code via Conductor worktrees (see [ADR-0001](0001-worker-agent-interface.md), specifically `ClaudeCodeWorker`). Each worker is a `claude` subprocess spawned by the orchestrator into a per-task worktree. Some authentication path must put valid credentials in front of that subprocess so it can call Anthropic's API.

The vision brief (`docs/vision.md` L43) originally locked in a different path: **OAuth via the Agent SDK, with an extra-usage fallback enabled, on a shared billing path with Conductor.** The intent was to spend already-paid-for Pro/Max subscription credits first and spill into pay-as-you-go transparently. The $500/mo cap at L44 was sized against that subscription-credit economics.

That path is no longer viable. As of **2026-02-19**, Anthropic's Agent SDK documentation explicitly requires API key authentication for SDK use. OAuth tokens minted for consumer subscription plans (Free / Pro / Max) are not accepted by the Agent SDK surface. Source: <https://platform.claude.com/docs/en/agent-sdk/overview>.

Because the worker tier is the only place in v1 that drives Claude programmatically at scale, this policy change forces a decision: either invent a non-SDK workaround for OAuth credit consumption, or move workers to API key auth. Continuing to plan around the OAuth path is not an option.

## Decision

**`ANTHROPIC_API_KEY` is the sole worker authentication mechanism for v1.** OAuth — both the Agent SDK OAuth flow and any consumer-plan token reuse — is explicitly off the roadmap for the worker tier. Revisit only if Anthropic ships first-party Agent SDK support for OAuth; today there is no signal that it is coming.

Mechanics:

- The daemon holds the API key in its own environment (loaded from operator-configured secret storage; the v1 implementation reads from a `.env` outside the repo).
- For each `ClaudeCodeWorker.start()`, the daemon spawns the `claude` subprocess with `ANTHROPIC_API_KEY` injected via `WorkerContext.env` (already the contract per ADR-0001 §Lifecycle).
- **The key MUST NOT be written to `~/.claude/.credentials.json`** or any other location that Claude Code's interactive session would consult. Workers receive the key only through the subprocess environment. This avoids two failure modes: (a) colliding with the developer's personal Claude Code session credentials on the same machine, and (b) leaking the worker key into interactive sessions that share the home directory.
- Spend control is layered at the Anthropic API-org level, not the subscription level:
  1. Organization-wide monthly spend cap configured in the Claude Console.
  2. Per-key spend cap on the key issued to Vibe Manager workers, so a runaway worker cannot drain the org budget reserved for other use.
- Per-task budget enforcement remains unchanged from ADR-0001: the orchestrator tracks `tokens_spent_cents` against `token_budget_cents` per the high-fidelity token-reporting path Claude Code already satisfies, and calls `stop()` on cap breach.

## What this supersedes

This ADR supersedes the following content in `docs/vision.md`:

- **L43, "Billing" row of the scope table.** The values "OAuth via Agent SDK, extra-usage fallback enabled, shared billing path with Conductor" are no longer the worker billing model. The replacement is API key auth with org + per-key spend caps as described above.
- **L44, "Monthly spend cap" row of the scope table — framing only, not the number.** The $500/mo figure is preserved as the v1 starting cap, but its rationale ("sized to force decisions about concurrency and context reuse") was implicitly anchored on subscription-credit economics. At API-tier pricing the same $500 buys materially different worker time. The cap stays at $500 for the dogfood phase as a forcing function; whether it remains the right number is flagged as an open question below, not resolved here.

The `docs/vision.md` file itself is **not edited in this ADR's PR**. The supersession is recorded here; the spec-file update is a separate concern and will be handled in a follow-up that also addresses unrelated injection-style content already present in that file.

## Consequences (positive)

- **Eliminates the account-level MCP subprocess auth-prompt risk.** OAuth flows in subprocesses can surface interactive auth prompts (browser hand-offs, device codes) that have no operator on the other end in a clamshell-mode MVP. API key auth has no interactive path.
- **Removes exposure to `--bare` deprecation drift.** The OAuth path was going to require specific Conductor CLI invocation patterns whose stability we do not control. API key auth is a direct contract with Anthropic and does not depend on Conductor CLI flag stability.
- **Removes the 2026-06-15 Agent SDK credit-pool concern.** The previously-planned credit-pool behavior change scheduled for that date is now irrelevant to the worker tier — we are not consuming credit-pool semantics at all.
- **Simplifies the A→C SaaS migration.** Version C (cloud SaaS) was always going to use customer-provided API keys; the worker tier is now already on the same auth model. There is no auth-layer rewrite in the A→C transition.
- **Cleaner per-worker cost accounting.** Per-key spend caps give a deterministic budget envelope that maps 1:1 to the `costPerMillionInputTokens` / `costPerMillionOutputTokens` fields in the `WorkerCapabilities` struct (ADR-0001).
- **Simpler failure model.** Auth either works (200) or returns 401. No token-refresh race conditions during long worker sessions.

## Consequences (negative / tradeoffs)

- **API-tier pricing math differs from subscription-flat economics.** An always-on orchestrator running N parallel workers on Opus 4.7 will burn through a flat dollar cap materially faster than subscription intuition suggests. The cap-vs-throughput tradeoff is now exposed and must be managed by routing easy tasks to Haiku 4.5 and by being deliberate about parallelism.
- **Key rotation is now the operator's responsibility.** Under the OAuth model, session refresh was Anthropic's concern. Under API key auth, the operator owns key lifecycle: rotation cadence, revocation on compromise, and provisioning a fresh key into the daemon's environment without dropping in-flight workers. For v1 this is acceptable (one operator, one machine); for SaaS this becomes per-tenant key management.
- **No fallback onto already-paid-for subscription credits.** Every worker token is billed at API rates from the first call. The "Pro/Max credits absorb the easy work" cushion the original plan assumed does not exist.
- **Operator must keep a separate Claude Code session for personal use.** Because the worker key is intentionally not written to `~/.claude/.credentials.json`, the operator's interactive Claude Code remains on its own OAuth session — fine, but worth naming so it is not later mistaken for a bug.

## Open questions

Flagged, not resolved in this ADR.

1. **Does the $500/mo cap still make sense at API-tier pricing?** The figure was sized against subscription economics. Resolution requires actual usage data from the dogfood phase: recompute against expected worker count × tasks/day × tokens/task at the realized Opus/Sonnet/Haiku model mix, then decide whether to hold, raise, or restructure the cap (e.g., express it as "N completed issues per month" rather than a flat dollar number). Do not pre-decide; revisit after the first matome.ai issue completes end-to-end.

## References

- Issue [#2](https://github.com/Arcadiann/vibe-manager/issues/2) — Decision: worker auth via ANTHROPIC_API_KEY only (deprecate OAuth path).
- Anthropic Agent SDK overview (policy requiring API key auth, effective 2026-02-19): <https://platform.claude.com/docs/en/agent-sdk/overview>.
- [ADR-0001](0001-worker-agent-interface.md) — WorkerAgent Interface Contract. Defines `WorkerContext.env` as the credential delivery channel this ADR relies on.
- `docs/vision.md` L43–L44 — superseded scope-table rows (file edit deferred to a separate PR).

## ADR-0003: Persistence schema

# ADR-0003: Persistence Schema — `tasks`, `task_dependencies`, `memory`, `events`

- Status: Proposed (operator review pending)
- Date: 2026-05-17
- Supersedes: —

## Context

Vibe Manager needs first-class persistence for three concerns the architecture has already identified ([`docs/vision.md`](../vision.md) "Architecture sketch"): work-in-flight (tasks with parent/child hierarchy, dependencies, and a state machine), semantic memory shared across agents (vector-searchable via pgvector), and an append-only audit log (every event the orchestrator and workers emit, sufficient to reconstruct "why did this happen at 2am"). [`docs/vision.md` open question #1](../vision.md) names "concrete Postgres schema for `tasks`, `memory`, `events` tables" as a planning-stage decision; this ADR resolves it.

The worker tier is already shipping events that need a destination. [ADR-0001](0001-worker-agent-interface.md) defines the `WorkerEvent` taxonomy (10 variants) and the worker state machine; [ADR-0002](0002-worker-auth-api-key.md) locks worker auth via `ANTHROPIC_API_KEY`. The orchestrator above the workers does not yet exist. The persistence schema is the next architectural decision because the orchestrator's task lifecycle, retry policy, budget accounting, and operator-visible state all assume properties of this storage layer.

Scope of this ADR: column-level schema design only. **Explicit non-goals:** ORM choice (Prisma vs. raw SQL vs. Kysely), migration tooling (Supabase CLI vs. Atlas vs. raw `psql`), RLS posture, and multi-tenancy (Version C SaaS). Each of those is a separate decision and must not be inferred from this document. The existing planning sketch in [`docs/planning/schema-proposal.md`](../planning/schema-proposal.md) was the working surface for this design; this ADR supersedes it as the architecture-of-record (the planning doc remains for historical context).

## Decision

Four tables in a dedicated schema `vibe_manager`: `tasks`, `task_dependencies`, `memory`, `events`. The orchestrator opens connections with `search_path = vibe_manager, public` so the `vector` extension (kept in `public` or `extensions`) is reachable without leaking app tables into `public`.

### `vibe_manager.tasks`

Every unit of work the orchestrator is aware of, from root task (operator-filed) down through Manager-Agent decomposition to individual worker assignments. Hierarchy is self-referential via `parent_task_id`.

| Column | Type | Null | Default | Justification |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK; UUID so the orchestrator can mint IDs before insertion. |
| `parent_task_id` | `uuid` | yes | — | FK → `tasks.id` ON DELETE CASCADE. Null at root. |
| `root_task_id` | `uuid` | no | — | FK → `tasks.id`. Equals `id` for roots, denormalized for descendants. Avoids `WITH RECURSIVE` on every "show me this run" query. |
| `title` | `text` | no | — | One-line summary, agent- or operator-authored. |
| `description` | `text` | no | — | Full task prompt / spec body. |
| `success_criteria` | `text` | yes | — | Forwarded into `TaskSpec.successCriteria` ([ADR-0001](0001-worker-agent-interface.md)). |
| `status` | `text` | no | `'pending'` | State machine vocabulary; CHECK-constrained. See §Status vocabulary below. |
| `status_reason` | `text` | yes | — | Free-form, set on every transition into a blocked or terminal state. |
| `created_by_agent` | `text` | no | — | `'human'`, `'vision'`, `'manager'`, or `'worker:<id>'`. Text rather than enum so new tiers do not require an `ALTER TYPE`. |
| `assigned_worker_type` | `text` | yes | — | E.g. `'claude-code'`. Null until a worker accepts the task. Matches `WorkerCapabilities.workerType`. |
| `assigned_session_handle` | `text` | yes | — | Opaque `SessionHandle` from `WorkerAgent.start()` ([ADR-0001](0001-worker-agent-interface.md) §Lifecycle). |
| `task_spec` | `jsonb` | yes | — | Frozen `TaskSpec` payload at assignment time. Reproducible audit. |
| `result` | `jsonb` | yes | — | Worker's `complete.result` payload (which is typed `unknown` in [ADR-0001](0001-worker-agent-interface.md), so jsonb is the natural fit). |
| `error` | `jsonb` | yes | — | Structured error if `status` is terminal-non-complete. Carries the worker's `failed` event payload including `recoverable` and `terminationMode` fields. |
| `budget_fidelity` | `text` | no | `'high'` | One of `'high'` or `'low'`. CHECK-constrained. Set by the orchestrator from the worker's token-reporting cadence ([ADR-0001](0001-worker-agent-interface.md) §Event stream). |
| `token_budget_cents` | `bigint` | yes | — | Per-task hard cap (USD cents). Null = inherit from parent or global default. |
| `tokens_spent_cents` | `bigint` | no | `0` | Updated on every `tokens` event the orchestrator consumes. `bigint` not `integer` — long subtree accumulation can exceed the ~$21M integer ceiling in pathological cases; cheap insurance. |
| `attempt_count` | `smallint` | no | `0` | Incremented on retry. |
| `created_at` | `timestamptz` | no | `now()` | |
| `started_at` | `timestamptz` | yes | — | First transition into `running`. |
| `completed_at` | `timestamptz` | yes | — | Transition into any terminal state. |

**Status vocabulary.** `CHECK (status IN ('pending', 'running', 'blocked', 'complete', 'failed', 'timed_out', 'cancelled'))`. This unifies [ADR-0001](0001-worker-agent-interface.md)'s `WorkerStatusReport.state` vocabulary across the worker and orchestrator tiers. The orchestrator-only extension is `'pending'` (task created or unblocked dependencies, not yet handed to a worker); every other value matches ADR-0001 exactly. [ADR-0001](0001-worker-agent-interface.md)'s `'starting'` worker state is **not** a separate task state — it is collapsed into `'running'` at the orchestrator's task level, because the operator's perspective is "in-flight," not "the subprocess has spawned but its first event has not yet arrived." `assigned_worker_type` plus `assigned_session_handle` carry the worker-side substate when it matters. Drift between the worker session state machine and the task state machine, if it appears in practice, is resolved by edits to this CHECK constraint; do not change ADR-0001 to match a schema choice.

**Indexes.**
- `tasks_parent_idx` on `(parent_task_id)` — children of a node.
- `tasks_root_idx` on `(root_task_id)` — fetch the full subtree for a user-visible run.
- `tasks_status_idx` on `(status)` WHERE `status IN ('pending','running','blocked')` — partial index over the hot working set.

**Concurrency.** No `version` column, no optimistic locking. v1 runs a single orchestrator process; row writes are serialized at the orchestrator layer. Consciously forecloses (a) multi-orchestrator deployments against one database, and (b) hand-editing rows via Supabase Studio mid-run. Acceptable for v1; revisit at Version C.

### `vibe_manager.task_dependencies`

Join table expressing "task A cannot start until task B reaches `complete`." Chosen over a `uuid[]` column on `tasks` for three reasons: real FKs at both ends (referential integrity), trivially enumerable in either direction (forward "what does A wait on" and reverse "what does B unblock"), and a clean place to attach future per-edge metadata (e.g., `edge_kind` for hard-vs-soft dependencies) without an `ALTER TABLE tasks`. The negative is one extra table to maintain; the positive is the operator's "what tasks does this unblock when it completes?" query — run on every task completion to advance ready successors — becomes an indexed reverse lookup instead of an array-containment scan.

| Column | Type | Null | Default | Justification |
|---|---|---|---|---|
| `task_id` | `uuid` | no | — | FK → `tasks.id` ON DELETE CASCADE. The dependent task. |
| `depends_on_task_id` | `uuid` | no | — | FK → `tasks.id` ON DELETE CASCADE. The upstream blocker. |
| `created_at` | `timestamptz` | no | `now()` | |

**Primary key:** `(task_id, depends_on_task_id)`. **Constraint:** `CHECK (task_id <> depends_on_task_id)`. Cycle detection is enforced at the orchestrator layer when the Manager Agent emits a graph; not enforced in SQL.

**Indexes.** The PK covers forward lookups. Add `task_dependencies_reverse_idx` on `(depends_on_task_id)` for the completion-advances-successors query.

### `vibe_manager.events`

Append-only audit log. Every decision, delegation, escalation, tool call, and worker event lands here.

| Column | Type | Null | Default | Justification |
|---|---|---|---|---|
| `id` | `bigserial` | no | — | PK. Monotonic ordering is part of the contract. |
| `ts` | `timestamptz` | no | `clock_timestamp()` | `clock_timestamp()` not `now()` — `now()` is transaction-stable; two events emitted in the same transaction would otherwise collide on timestamp and lose intra-transaction ordering. |
| `kind` | `text` | no | — | Variant discriminator. Text + CHECK rather than enum so new kinds (and new `WorkerEvent` variants under [ADR-0001](0001-worker-agent-interface.md)) do not require `ALTER TYPE`. |
| `task_id` | `uuid` | yes | — | FK → `tasks.id` ON DELETE SET NULL. Null for system-wide events (orchestrator boot, key rotation, etc.). |
| `root_task_id` | `uuid` | yes | — | Denormalized for "give me all events for this run." |
| `agent` | `text` | yes | — | Who produced the event. `'orchestrator'`, `'vision'`, `'manager'`, `'worker:<session_handle>'`, or `'system'`. |
| `parent_event_id` | `bigint` | yes | — | FK → `events.id`. Causal chain — a `tool_result` points at the `tool_call` it answers. |
| `payload` | `jsonb` | no | `'{}'` | Variant-specific body. TypeScript types in `src/workers/types.ts` and the forthcoming orchestrator package are the schema-of-record; the database is intentionally schemaless on this column. |
| `payload_summary` | `text` | yes | — | Optional one-line human-readable summary for `grep`-style log reading without `jsonb_path_query`. |

**Variant discrimination.** The 10 [ADR-0001](0001-worker-agent-interface.md) `WorkerEvent` variants — `heartbeat`, `log`, `progress`, `tool_call`, `tool_result`, `file_edit`, `tokens`, `blocked`, `complete`, `failed` — map onto `kind = 'worker_event:<variant>'` (e.g. `'worker_event:tokens'`). The variant-specific fields land in `payload`. Orchestrator-emitted events use distinct `kind` prefixes (`'task_*'`, `'agent_*'`, `'escalation_*'`, `'budget_*'`).

**Lossless audit of `WorkerEvent`.** Every variant's fields are JSON-serializable primitives (`number`, `string`, `boolean`, enums-as-strings) or `unknown` payloads that are JSON by construction (`complete.result`, `failed.payload`). `jsonb` represents all 10 variants without information loss, including the additive cache-token fields on `tokens` and the optional `terminationMode` on `failed` (see [`src/workers/types.ts:46-86`](../../src/workers/types.ts)).

**Tradeoff: `payload jsonb` loses column-level constraints.** A schema with one column per `WorkerEvent` variant would catch malformed events at insert time; `jsonb` shifts that validation into the orchestrator (the producer) and into TypeScript types. We accept this because the variant set evolves (the cache-token and `terminationMode` additions already happened post-[ADR-0001](0001-worker-agent-interface.md)) and per-variant tables would force a migration on every change. The orchestrator owns shape validation before insert.

**Append-only.** No `UPDATE` or `DELETE` from application code. Enforced at the orchestrator layer for v1; can be hardened with a trigger or RLS policy later. The "is the trigger worth its weight in v1" call is flagged as an open question.

**Retention.** Default **90 days**, enforced by a periodic delete (orchestrator-side or pg_cron). Operator decision: the right number depends on dogfood-phase observed event volume and on how often the operator actually replays a long-running run. The 90-day default is conservative enough for typical retrospective debugging without unbounded growth on a busy day; the figure is **flagged as an operator decision** rather than a fixed contract.

**Indexes.**
- `events_task_ts_idx` on `(task_id, ts)` — reconstruct one task's timeline (the orchestrator's primary read path).
- `events_root_ts_idx` on `(root_task_id, ts)` — reconstruct a full run for the operator.
- `events_kind_ts_idx` on `(kind, ts)` — cross-task analytics by event kind (budget warnings over time, escalation cadence, etc.).
- `events_parent_idx` on `(parent_event_id)` — causal-chain traversal.
- `events_id_brin` BRIN on `(id)` — append-only table; BRIN is essentially free and helps range scans during replay. Skip if the planner already prefers the PK.

### `vibe_manager.memory`

Semantic memory store. One row per chunk of text plus its embedding plus provenance. Reads via pgvector similarity search.

| Column | Type | Null | Default | Justification |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK. |
| `content` | `text` | no | — | The human-readable text that was embedded. Always present alongside the vector so a row remains debuggable after a model swap. |
| `summary` | `text` | yes | — | Optional one-line title for retrieval-result display without re-reading `content`. |
| `embedding` | `halfvec(3072)` | no | — | Dimension fixed to match the v1 embedding model (`text-embedding-3-large`). `halfvec` (16-bit per component) rather than `vector` so HNSW indexes at 3072 dims without ceremony; storage halves with negligible recall loss at this scale. |
| `embedding_model` | `text` | no | `'text-embedding-3-large'` | Stored per row. Mixing model versions in one HNSW index destroys recall; the column lets us re-embed during a future migration without losing provenance. |
| `kind` | `text` | no | — | Loose taxonomy: `'lesson'`, `'fact'`, `'codebase-quirk'`, `'decision'`, `'preference'`. Text + CHECK rather than enum. |
| `tier` | `text` | no | — | Which agent tier wrote this row: `'vision'`, `'manager'`, `'worker'`, or `'system'`. Distinct from `created_by_agent` in `tasks` because memory is queried by tier far more often than by individual agent identity. |
| `created_by_agent` | `text` | no | — | The specific agent that wrote this row (e.g., `'worker:claude-code:42a1...'`). |
| `task_id` | `uuid` | yes | — | FK → `tasks.id` ON DELETE SET NULL. The task this memory came from, if any. |
| `event_id` | `bigint` | yes | — | FK → `events.id` ON DELETE SET NULL. The specific event that produced this memory, if any. Provenance for memories distilled from a `complete` event's result, an escalation outcome, etc. |
| `source` | `text` | no | — | Top-level provenance category: `'task'`, `'event'`, `'external'`. Disambiguates rows where both FKs are null (`'external'` — operator-supplied or imported memory). CHECK-constrained. |
| `metadata` | `jsonb` | no | `'{}'` | Open-ended tags / paths / expiry hints. |
| `created_at` | `timestamptz` | no | `now()` | |
| `last_used_at` | `timestamptz` | yes | — | Updated whenever a retrieval surfaces this row. Lets us prune dead memories later. |

**Embedding dimension and model.** Committed to **3072-dimensional `halfvec`** matching OpenAI's `text-embedding-3-large`. The model itself is **not yet covered by a dedicated ADR** — the choice was made in `docs/planning/schema-proposal.md` and is propagated here, but the rationale (vs. `text-embedding-3-small` at 1536, or a self-hosted embedder) has not been written down. **Flagged as an open question.** The committed dimension is on the schema; switching models means a re-embed migration, not a column type change (provided the new model fits 3072 dims; otherwise the column type itself is a migration).

**Index type — HNSW.** `memory_embedding_hnsw` HNSW on `(embedding halfvec_cosine_ops)`. Justified for v1:
1. **Recall and latency over build cost.** HNSW gives better recall-at-low-k than IVFFlat at the small-to-medium row counts the dogfood phase will produce. IVFFlat wins on build time at scale and on memory footprint with very large row counts; we have neither problem yet.
2. **Halfvec at 3072 dims is HNSW-ready** in pgvector ≥ 0.7.0, which Supabase ships. IVFFlat at 3072 dims requires the same halfvec workaround and gains less from the smaller storage footprint.
3. **Reads dominate.** Memory retrieval is on every agent turn; writes are at task completion. HNSW's read-side advantage matters more than its build-side cost.

The pick may need revisiting once memory row count crosses ~1M (HNSW build/update cost rises; IVFFlat's "cheap rebuild on bulk insert" pattern becomes attractive). **Flagged as a known revisit point**, not a current open question — the data to make the call doesn't exist yet, and the table can swap index types with downtime measured in minutes at v1 volumes.

**Indexes (full set).**
- `memory_embedding_hnsw` HNSW on `(embedding halfvec_cosine_ops)` — primary retrieval.
- `memory_metadata_gin` GIN on `(metadata jsonb_path_ops)` — filtered retrieval (e.g., `metadata @> '{"repo": "matome"}'`).
- `memory_kind_idx` on `(kind)`.
- `memory_tier_idx` on `(tier)` — tier-scoped retrieval (e.g., "what does the Manager Agent know that workers don't").
- `memory_task_idx` on `(task_id)` WHERE `task_id IS NOT NULL`.

## Lossless `WorkerEvent` audit — per-variant field shape

Verified against [`src/workers/types.ts:46-86`](../../src/workers/types.ts). All field types are JSON-serializable; `jsonb payload` stores each variant losslessly.

| Variant | Fields beyond `kind` and `at` | jsonb-safe? |
|---|---|---|
| `heartbeat` | — | yes |
| `log` | `level: 'info'\|'warn'\|'error'`, `message: string` | yes |
| `progress` | `note: string` | yes |
| `tool_call` | `toolCallId: string`, `tool: string`, `argsPreview: string` | yes |
| `tool_result` | `toolCallId: string`, `ok: boolean`, `resultPreview: string` | yes |
| `file_edit` | `path: string`, `bytesChanged: number` | yes |
| `tokens` | `inputTokens: number`, `outputTokens: number`, `cacheCreationInputTokens?: number`, `cacheReadInputTokens?: number` | yes |
| `blocked` | `reason: string`, `needs: string` | yes |
| `complete` | `partial: boolean`, `result: unknown` | yes (`unknown` here is constrained to JSON by ADR-0001's "All return values are serializable" contract) |
| `failed` | `reason: string`, `recoverable: boolean`, `payload?: unknown`, `terminationMode?: 'sigterm'\|'sigkill'` | yes (same `unknown`-is-JSON constraint) |

No variant has a field that needs out-of-band binary storage, a non-JSON-serializable shape (Date objects, Buffers, Maps), or a representation that loses information in jsonb. Future `WorkerEvent` variants that introduce non-JSON-serializable fields would break this audit — the orchestrator's event-writer is the right place to enforce the constraint going forward.

## Consequences (positive)

- **Unblocks the orchestrator.** Task lifecycle, retry policy, budget accounting, and operator-facing dashboards all have a destination to read and write to.
- **Lossless audit.** Every `WorkerEvent` lands in `events` without dropping fields; replay can reconstruct what every agent saw.
- **Hierarchical task model with cheap subtree queries.** `root_task_id` denormalization removes recursive CTEs from the hot path.
- **Memory is provenance-aware.** `task_id`, `event_id`, `tier`, `source`, and `embedding_model` together let us trace any retrieved memory back to who produced it and under what model — necessary for re-embedding migrations and for debugging memory-driven decisions.
- **Vocabulary unifies with [ADR-0001](0001-worker-agent-interface.md).** `tasks.status` matches `WorkerStatusReport.state` everywhere they overlap; the orchestrator-only extension (`'pending'`) is named explicitly.
- **A→C migration is column-free.** The schema does not bake in single-tenant assumptions in column shapes (no implicit "one operator" in any FK). Adding a `tenant_id` column at Version C is additive, not a rewrite.

## Consequences (negative / tradeoffs)

- **`payload jsonb` loses column-level typing on `events`.** Malformed events fail to be caught at the database boundary. Mitigation: orchestrator validates `WorkerEvent` shape against the TypeScript types before insert; this is the only writer path.
- **Embedding dimension is committed.** Switching to a 1536-dim model means an `ALTER TABLE` plus a re-embed; switching to a different-dim model means a column type migration. The 3072 choice has not been independently justified by a dedicated ADR — see open questions.
- **Retention default of 90 days is operator-overridable but materially affects long-running root-task audit.** A root task that lives 6 months and gets replayed will lose its early events under the default. Flagged for operator decision.
- **HNSW choice may need revisiting at scale.** Build/update cost rises with row count; IVFFlat becomes competitive past ~1M rows. Mitigation: index type can be swapped with minutes of downtime at v1 volumes.
- **No row-level concurrency control on `tasks`.** Single-orchestrator deployments only. Multi-orchestrator and Supabase-Studio-mid-run are foreclosed.
- **Append-only enforcement is application-layer.** A misbehaving SQL client (or future automation) can violate the audit-log contract; the database does not stop it. Trigger-based enforcement is flagged as open.

## Open questions

Each becomes a follow-up issue and must resolve before this ADR moves from Proposed → Accepted.

1. **Embedding model selection — formal record.** The 3072-dim `text-embedding-3-large` choice is propagated from `docs/planning/schema-proposal.md` without a dedicated ADR justifying it against alternatives (`text-embedding-3-small` at 1536 dims, self-hosted bge / e5, multi-model setups). The dimension commitment on the schema makes this decision binding on the column type; needs an ADR (or a "stay with the default, here's why" written record).
2. **`events` retention default — operator decision.** 90 days proposed. Resolution requires dogfood-phase event-volume measurements and a stated retrospective-debugging horizon. The number can be a CHECK-free constant in the deletion job; the policy itself is what needs sign-off.
3. **Append-only enforcement on `events` — trigger vs. application-layer.** v1 trusts the orchestrator as the sole writer. Question: is a `BEFORE UPDATE OR DELETE` trigger that raises `EXCEPTION` worth its weight now (catches accidental Supabase-Studio mutations, future bots) versus deferred to when a real violation appears?
4. **Post-task memory summarizer — synchronous or deferred.** Affects perceived task latency and operator-visible state in the dashboard. Sync = simpler causality (task `complete` implies memory written) at the cost of latency on the operator's "task done?" view. Deferred = faster perceived completion at the cost of a window where a `complete` task has no associated memory rows.
5. **Soft-delete / "forget task" path.** No `deleted_at` columns in this proposal. If we ever need to remove a task for legal or operator reasons, do we hard-delete with cascades (events go with the task, memory rows orphan to `task_id = NULL`), or add a soft-delete flag and filter everywhere? Defer until someone asks; track the question so we don't bake in a hard-delete assumption that gets painful later.
6. **`tasks.status` vocabulary drift detection.** [ADR-0001](0001-worker-agent-interface.md)'s `WorkerStatusReport.state` and this ADR's `tasks.status` are intentionally aligned today, but future worker states would require a CHECK update here and a documentation pass to keep them in sync. Question: do we add a test that asserts the two vocabularies are equal modulo the orchestrator-only `'pending'` extension, or rely on review discipline?

## What this defers

Not goals of this ADR; future decisions required:

- **ORM choice.** Prisma, Kysely, raw `pg`, or none of the above. The schema is ORM-independent; the choice is a separate ADR.
- **Migration tooling.** Supabase CLI, Atlas, sqitch, or raw `psql` scripts checked into the repo. Independent decision.
- **RLS policies.** This ADR does not turn on row-level security or write any policies. v1 is single-tenant on a trusted Supabase project; RLS becomes relevant at Version C and gets its own ADR.
- **Multi-tenancy (Version C SaaS).** No `tenant_id` columns; no per-tenant key/encryption story. Additive when Version C lands.
- **Operator dashboard query patterns.** Indexes here are sized for the orchestrator's reads, not for ad-hoc operator analytics. Additional indexes may be warranted once operator query patterns settle.

## References

- [`docs/vision.md`](../vision.md) — open question #1 ("concrete Postgres schema for `tasks`, `memory`, `events` tables") resolved here.
- [ADR-0001](0001-worker-agent-interface.md) — WorkerAgent Interface Contract. Defines `WorkerEvent` taxonomy and `WorkerStatusReport.state` vocabulary that this schema audits losslessly and unifies with.
- [ADR-0002](0002-worker-auth-api-key.md) — Worker Authentication via `ANTHROPIC_API_KEY`. Establishes the credential delivery channel; not modified by this ADR.
- [`docs/planning/schema-proposal.md`](../planning/schema-proposal.md) — prior planning draft; this ADR supersedes it as the architecture-of-record.
- [`src/workers/types.ts`](../../src/workers/types.ts) — `WorkerEvent` union the `events.payload` column must accommodate.
- Follow-up issues (all must resolve before Proposed → Accepted). Issues #33–#38 were filed alongside the ADR's initial draft; issues #41–#47 were surfaced during operator review and are additional pre-Accepted gates against the same Status.
  - [#33](https://github.com/Arcadiann/vibe-manager/issues/33) — embedding model selection (formal record).
  - [#34](https://github.com/Arcadiann/vibe-manager/issues/34) — `events` retention default.
  - [#35](https://github.com/Arcadiann/vibe-manager/issues/35) — append-only enforcement on `events`.
  - [#36](https://github.com/Arcadiann/vibe-manager/issues/36) — post-task memory summarizer timing.
  - [#37](https://github.com/Arcadiann/vibe-manager/issues/37) — soft-delete / forget-task path.
  - [#38](https://github.com/Arcadiann/vibe-manager/issues/38) — `tasks.status` ↔ ADR-0001 vocabulary drift detection.
  - [#41](https://github.com/Arcadiann/vibe-manager/issues/41) — schema fix: `tokens_spent_cents` bigint rounds individual tokens to zero.
  - [#42](https://github.com/Arcadiann/vibe-manager/issues/42) — task `idempotency_key` for restart-mid-run dedup.
  - [#43](https://github.com/Arcadiann/vibe-manager/issues/43) — clarification: `status_reason` is current-only; use `events` for transition history.
  - [#44](https://github.com/Arcadiann/vibe-manager/issues/44) — audit guarantee: `task_spec` vs rendered worker prompt.
  - [#45](https://github.com/Arcadiann/vibe-manager/issues/45) — docs: `memory.event_id` provenance is soft (events retention nulls it).
  - [#46](https://github.com/Arcadiann/vibe-manager/issues/46) — forward-flag: `memory.last_used_at` write-amplification at scale.
  - [#47](https://github.com/Arcadiann/vibe-manager/issues/47) — migration constraint: explicitly disable RLS on `vibe_manager` tables.

## How to use this file

This file exists so a new advisor chat can fetch ONE raw URL and get the full canonical context, instead of fetching multiple files (which the web fetcher's allowlist treats inconsistently). The raw URL pattern is https://raw.githubusercontent.com/Arcadiann/vibe-manager/main/docs/advisor-bootstrap.md. Paste this URL as plain text (not markdown auto-link) into the new advisor chat to bootstrap. ADR-0003 is currently Proposed (not Accepted) and has 13 open pre-Accepted gates filed as issues #33–#38 and #41–#47 that must resolve before it can be marked Accepted.
