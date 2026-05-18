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
