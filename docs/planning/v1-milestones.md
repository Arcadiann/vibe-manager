# v1 Milestone Breakdown

Working backward from the acceptance test in [docs/vision.md](../vision.md): the founder files matome.ai issue #97 with one command, walks away, returns to a reviewable PR plus Slack DMs for vision-level decisions, under the $500/mo cap.

Eight milestones (six numbered slots, two pairs split into a/b). M1 is the smallest end-to-end vertical slice; persistence, operator visibility, and real worker integration come after. Each milestone is shippable in the sense that it leaves the system in a demonstrable, testable state.

---

## M1 — Vertical slice (in-memory)

**Goal.** Prove the three-tier hand-off works end-to-end before any persistence or real worker exists.

**Scope.** A CLI command accepts a trivial task ("write a haiku to stdout"). A Vision Agent calls a Manager Agent calls one Worker Agent (a stub that satisfies the `WorkerAgent` interface). The stub doesn't just return a string — it emits a realistic event stream so we exercise the streaming contract, not only the method signatures. Results bubble back up and print to the console. All state in-memory; no Postgres, no Slack, no Conductor worktree.

**Acceptance criteria.**
- `vibe run "write a haiku"` returns the haiku string within ~30s.
- The stub WorkerAgent implementation passes a conformance test against the interface contract.
- The stub emits a realistic event sequence during a run: at least one `progress` event, at least one `tokens` event, and exactly one terminal `complete` event. The orchestrator consumes the full stream — not just the final result — and aggregates `tokens` correctly. The streaming contract is the point of M1, not the method shape.
- Vision → Manager → Worker is genuinely three separate agent calls (or three separate prompts to the same model), not collapsed for convenience.
- A test exercises the full path with a recorded fixture.

**Scope estimate.** Small.

**Dependencies.** ADR-0001 (WorkerAgent interface contract) must be merged first.

**Open questions.**
- Do Vision Agent and Manager Agent share a chat session, or is each invocation a fresh prompt with retrieved context? (M1 can pick either; M2 may need to revisit.)
- What's the wire format between Manager and Worker — structured TaskSpec object only, or also a freeform prompt field?

---

## M2 — Persistence layer and operator visibility

**Goal.** Replace in-memory state with the Postgres-backed `tasks`, `task_dependencies`, `memory`, `events` schema, and give the operator the live read-paths they'll need to trust the system.

**Scope.** Apply the schema (proposed in [schema-proposal.md](schema-proposal.md)) on the existing Supabase project under the `vibe_manager` schema. Wire the orchestrator so every state transition writes an event; tasks are read/updated through the table; memory is written but not yet retrieved (retrieval lands in M4b). Ship three operator-facing CLI commands: `vibe status <root_task_id>` (current tree state — every task in the subtree with status, assigned worker, tokens spent), `vibe tail <root_task_id>` (live event stream from `events` for that run, filtered by `root_task_id`, tailing as new rows arrive), and `vibe replay <root_task_id>` (deterministic ordered reconstruction of the run from events).

**Acceptance criteria.**
- M1's haiku flow still works, now backed by Postgres.
- After running a task, `select * from vibe_manager.events where root_task_id = ...` shows the full causal chain: task created, assigned, worker events, complete.
- Killing the orchestrator mid-task and restarting reads the task row and either resumes or marks it failed-on-restart with a clean event.
- `vibe status` returns within 500ms even for a tree with 50 tasks.
- `vibe tail` shows new events with sub-second latency while a run is in flight.
- `vibe replay` produces a deterministic, ordered trace that matches what `vibe tail` would have shown live.
- Migrations live in the repo, not in Supabase Studio.

**Scope estimate.** Medium.

**Dependencies.** Schema proposal (Artifact 2) must be reviewed and approved. M1.

**Open questions.**
- Mid-task crash policy: auto-resume on restart, or always mark failed and let the operator re-file? (Vision brief doesn't say.)
- `vibe tail` transport: `LISTEN/NOTIFY` on insert into `events`, polling, or logical replication? (Defer to the M2 implementer.)

---

## M3a — Real ClaudeCodeWorker (happy path)

**Goal.** Replace the stub worker with a real `ClaudeCodeWorker` that runs `claude` in a Conductor worktree and produces a real git commit on a clean run.

**Scope.** Implement `ClaudeCodeWorker` against the ADR-0001 interface for the happy path only. The worker spawns Claude Code as a subprocess in a fresh Conductor worktree, streams its events back through `WorkerAgent.stream()`, and on completion produces a branch with one or more commits. The orchestrator opens a PR via `gh` (no merge). Use a small but real task (e.g., "add a one-line comment to README.md in some sandbox repo") as the integration target. No multi-task decomposition yet. No failure-mode hardening — that's M3b.

**Acceptance criteria.**
- A single-task run against a sandbox repo produces a real PR on a feature branch.
- Worker output is streamed to `events` in near-real-time (not buffered until completion).
- Capabilities discovery works: `worker.capabilities()` returns the actual Claude model in use and a non-fabricated cost-per-token from configuration.
- The worker honors the high-fidelity token-reporting cadence specified in ADR-0001 (events at least every 10s or every 5K output tokens).
- Round-trip: operator invokes a real task, orchestrator opens a real PR, operator can read it.

**Scope estimate.** Medium.

**Dependencies.** M2. ADR-0001 must already be merged.

**Open questions.**
- How does the worker stream events back? (Stdout parse vs. file tail vs. Conductor API if exposed — vision question #2.) Pick during M3a.
- Authentication: how does the spawned `claude` subprocess inherit the OAuth credentials cleanly?

---

## M3b — Worker reliability

**Goal.** Harden `ClaudeCodeWorker` against the failure modes specified in ADR-0001 — crash, timeout, zombie, stop unresponsive — and prove worktree cleanup is reliable.

**Scope.** Implement and test the orchestrator's response to every failure mode in the ADR-0001 error semantics table. Add a worktree reaper (background process that cleans up orphaned worktrees if the orchestrator itself crashed). Verify the strengthened `stop()` contract — no further `tokens` events after the grace window — using a synthetic worker that intentionally violates the contract and confirming the orchestrator does the right thing.

**Acceptance criteria.**
- Crash test: SIGKILL the worker subprocess mid-run. Orchestrator detects via stream-end-without-complete, writes a `failed` event with synthetic reason `stream_closed_without_terminal`, and the worktree is cleaned up.
- Timeout test: set a 10s deadline on a task that would naturally run longer; orchestrator calls `stop()`, the process group is force-killed, no `tokens` events arrive after the grace window, task is recorded as `timed_out`.
- Zombie test: synthetic worker stops emitting events for `HEARTBEAT_INTERVAL_MS * 3`; orchestrator detects, calls `stop()`, records `failed` with reason `zombie`.
- Stop-unresponsive test: synthetic worker ignores SIGTERM; orchestrator force-terminates via process group SIGKILL, records `failed` with reason `stop_timeout`.
- Worktree reaper: launch 5 fake worktrees, kill the orchestrator, restart; the reaper cleans them up within 60s and writes a `worktree_reaped` event.

**Scope estimate.** Medium.

**Dependencies.** M3a.

**Open questions.**
- Cleanup boundary: under what conditions is a worktree preserved for post-mortem rather than reaped? (Suggest: any `failed` task with reason ∈ {`stream_closed_without_terminal`, `stop_timeout`} keeps its worktree for N hours.)

---

## M4a — Decomposition and parallelism

**Goal.** Manager Agent decomposes work into a real task graph and the orchestrator runs ready tasks in parallel under a dependency-aware scheduler.

**Scope.** Manager Agent prompt is upgraded to produce a task graph (N tasks with explicit edges expressed as `task_dependencies` rows) instead of a single task. Orchestrator runs ready tasks (tasks whose upstream dependencies are all `complete`) in parallel up to a configurable concurrency limit. Manager receives worker outputs and synthesizes a final parent-task result. No memory retrieval yet — that's M4b.

**Acceptance criteria.**
- A task that obviously decomposes (e.g., "add a test, then a fixture, then refactor X to use the fixture") runs as ≥3 distinct task rows with correctly-populated `task_dependencies` edges.
- The reverse-lookup index on `task_dependencies` is exercised on every task completion to advance newly-ready successors.
- Concurrency cap is honored under load: 5 ready tasks with cap=2 → at most 2 running at a time, observable via `vibe status`.
- The Manager's synthesis pass produces a parent-task result that references its children's outputs.
- Cycle in the proposed graph is detected by the orchestrator and reported as a graph-construction error (not allowed to start).

**Scope estimate.** Large.

**Dependencies.** M3b.

**Open questions.**
- Concurrency cap default value (vision question #6). Suggest starting at 2 and tuning from real usage.
- How does the Manager know when it's "done" and synthesis should fire — explicit termination event from the worker, or graph-completion check on the orchestrator side?

---

## M4b — Memory retrieval

**Goal.** Memory becomes useful — agents retrieve relevant past memories on every call, not just write them at completion.

**Scope.** Before each agent call (Vision, Manager, Worker), the orchestrator runs a top-K semantic retrieval against `vibe_manager.memory` using the task description (plus parent context) as the query. Retrieved memories are injected into the agent's context. Tune the retrieval pipeline: chunking strategy for the source text, retrieval-k (probably 5–10 starting point), score thresholds for "actually relevant" vs. "skip injection," and the `last_used_at` write-back on every retrieval. Both memory-write paths from the schema proposal land here: the post-task summarizer and the explicit `remember(...)` callable.

**Acceptance criteria.**
- A planted "we use vitest, not jest" memory in the seeded `memory` table steers a downstream worker's testing-library choice on a relevant task.
- Retrieval-k, chunking, and threshold values are configurable, not hardcoded; defaults are documented in the repo.
- `last_used_at` updates when a memory is surfaced by retrieval.
- Post-task summarizer runs at every task completion (sync or async — see open question) and writes at least one memory row per task that produced a notable artifact.
- The explicit `remember(...)` callable exists and is exercised by at least one Manager-Agent prompt instruction in test.

**Scope estimate.** Medium.

**Dependencies.** M4a.

**Open questions.**
- Synchronous vs. asynchronous post-task summarization (affects perceived task latency).
- Default retrieval-k and similarity threshold. Tune from real dogfood data.

---

## M5 — Decision router and Slack escalation

**Goal.** Vision Agent becomes a real binary classifier; escalations land in the founder's Slack DM with enough context for a 5-minute decision.

**Scope.** Implement the decision router as a Claude call against the rubric in the vision brief, outputting `{escalate, reason, urgency}`. On `escalate: true`, format a Slack DM with: original task, what the agent wants to do, why this is flagged, links to relevant events/diff, and reply options. The system pauses the affected task branch until the operator replies. Reply mechanism is Slack reactions (✅ proceed, ❌ stop, ❓ ask-for-more-context) plus optional free-form text in-thread for nuance. No SMS fallback — deferred to post-MVP.

**Acceptance criteria.**
- A task that touches `auth.*` files triggers an escalation; a task that renames an internal variable does not.
- The Slack DM payload includes everything specified in the rubric and renders cleanly on mobile.
- Operator can resolve an escalation by adding ✅ / ❌ / ❓ reaction to the DM; orchestrator detects the reaction and resumes / terminates / re-asks accordingly.
- A free-form text reply in the same thread is captured into the resumed task's context (so the operator can add nuance without typing a long preamble).
- All escalation send/receive events land in the `events` table.

**Scope estimate.** Medium.

**Dependencies.** M4b. Slack app credentials provisioned by operator (see [escalation-target.md](escalation-target.md)).

**Open questions.**
- Slack escalation message format (vision question #4) — needs design work; suggest one round of iteration during M5.
- Default behavior when no operator reply arrives — does the task stay paused indefinitely, or is there a max-pause timeout? (Without SMS fallback, there's no escalation-of-the-escalation, so the answer matters.)

---

## M6 — Budget caps, reliability, issue #97 end-to-end

**Goal.** Ship-readiness. Enforce the per-task and monthly budget caps, harden the long-tail of reliability issues that surface only during real runs, and run the actual acceptance test: file matome.ai issue #97 and verify all five acceptance criteria hold.

**Scope.** Implement per-task token budget enforcement: terminate-on-exceed for high-fidelity workers (relies on ADR-0001's strengthened `stop()` contract), reconcile-after-the-fact for low-fidelity workers. Confirm Anthropic Console monthly cap of $500 is active and the orchestrator gracefully degrades when it hits. Add retry policy for worker crashes (N=2 default; configurable). Run the issue #97 dogfood pass; collect notes; fix what breaks. No new features in M6 — only reliability and the acceptance test itself.

**Acceptance criteria.**
- Per-task budget cap (high-fidelity worker): a task exceeding the cap is terminated mid-run, surfaced as `failed` with reason `budget_exceeded`. No `tokens` events arrive after the orchestrator's `stop()` grace window.
- Per-task budget cap (low-fidelity worker): the task runs to completion; spent-cents is reconciled from the terminal `tokens` event; if the cap was exceeded, the task is flagged but not retroactively failed.
- Worker crash retry: after a worker fails with crash semantics (recoverable), orchestrator restarts the same task up to N times before giving up.
- Monthly cap: when Anthropic returns insufficient-credit, orchestrator stops issuing new worker calls and notifies the operator.
- Acceptance test: founder runs the issue #97 command, closes the lid, returns to a reviewable PR on matome.ai with appropriate Slack DMs in the inbox, under $500 spent.

**Scope estimate.** Medium.

**Dependencies.** M5.

**Open questions.**
- Budget-exceeded behavior: terminate vs. escalate to vision for permission to raise the cap? Both valid; the answer depends on how often it fires in practice.
- Retry count default and backoff policy.
- What constitutes "reviewable" for the issue #97 PR — does the orchestrator pre-review/critique its own output, or is that a post-MVP feature?

---

## Cross-milestone notes

- **No GitHub Issues yet.** Milestones are tracked here, not in an issue tracker, per planning-run constraints.
- **Schema (Artifact 2) blocks M2.** WorkerAgent interface (Artifact 3) blocks M1.
- **What's deliberately not a milestone.** Drag-and-drop UI, non-Claude workers, multi-tenancy, cloud backend, web dashboard, nested hierarchies, cost optimization beyond hard caps, SMS escalation fallback. All deferred to post-MVP per the vision brief or this planning round.
- **Risk concentration.** M3a/M3b (real worker streaming + reliability) and M5 (decision router quality) are where the system is most likely to under-deliver. Both warrant a dedicated dogfooding pass before declaring done.
