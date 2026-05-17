# v1 Milestone Breakdown

Working backward from the acceptance test in [docs/vision.md](../vision.md): the founder files matome.ai issue #97 with one command, walks away, returns to a reviewable PR plus Slack DMs for vision-level decisions, under the $500/mo cap.

Six milestones. M1 is the smallest end-to-end vertical slice; persistence and real worker integration come after. Each milestone is shippable in the sense that it leaves the system in a demonstrable, testable state.

---

## M1 — Vertical slice (in-memory)

**Goal.** Prove the three-tier hand-off works end-to-end before any persistence or real worker exists.

**Scope.** A CLI command accepts a trivial task ("write a haiku to stdout"). A Vision Agent calls a Manager Agent calls one Worker Agent (a stub that satisfies the `WorkerAgent` interface and produces fake output). Results bubble back up and print to the console. All state in-memory; no Postgres, no Slack, no Conductor worktree.

**Acceptance criteria.**
- `vibe run "write a haiku"` returns the haiku string within ~30s.
- The stub WorkerAgent implementation passes a conformance test against the interface contract.
- Vision → Manager → Worker is genuinely three separate agent calls (or three separate prompts to the same model), not collapsed for convenience.
- A test exercises the full path with a recorded fixture.

**Scope estimate.** Small.

**Dependencies.** ADR-0001 (WorkerAgent interface contract) must be merged first.

**Open questions.**
- Do Vision Agent and Manager Agent share a chat session, or is each invocation a fresh prompt with retrieved context? (M1 can pick either; M2 may need to revisit.)
- What's the wire format between Manager and Worker — structured TaskSpec object only, or also a freeform prompt field?

---

## M2 — Persistence layer

**Goal.** Replace in-memory state with the Postgres-backed `tasks`, `memory`, `events` triad.

**Scope.** Apply the schema (proposed in [schema-proposal.md](schema-proposal.md)) on the existing Supabase project under the `vibe_manager` schema. Wire the orchestrator so every state transition writes an event; tasks are read/updated through the table; memory is written but not yet retrieved (retrieval lands in M4). Add a `vibe replay <task_id>` command that reconstructs system state from the events table.

**Acceptance criteria.**
- M1's haiku flow still works, now backed by Postgres.
- After running a task, `select * from vibe_manager.events where task_id = ...` shows the full causal chain: task created, assigned, worker events, complete.
- Killing the orchestrator mid-task and restarting reads the task row and either resumes or marks it failed-on-restart with a clean event.
- `vibe replay` produces a deterministic, ordered trace.
- Migrations live in the repo, not in Supabase Studio.

**Scope estimate.** Medium.

**Dependencies.** Schema proposal (Artifact 2) must be reviewed and approved. M1.

**Open questions.**
- Mid-task crash policy: auto-resume on restart, or always mark failed and let the operator re-file? (Vision brief doesn't say.)
- Where do migrations live and what tool runs them? (Defer to the M2 implementer; not a planning concern.)

---

## M3 — Real ClaudeCodeWorker

**Goal.** Replace the stub worker with a real `ClaudeCodeWorker` that runs `claude` in a Conductor worktree and produces a real git commit.

**Scope.** Implement `ClaudeCodeWorker` against the ADR-0001 interface. The worker spawns Claude Code as a subprocess in a fresh Conductor worktree, streams its events back through the `WorkerAgent.stream()` iterator, and on completion produces a branch with one or more commits. The orchestrator opens a PR via `gh` (no merge). Use a small but real task (e.g., "add a one-line comment to README.md in some test repo") as the integration target. No multi-task decomposition yet.

**Acceptance criteria.**
- A single-task run against a sandbox repo produces a real PR on a feature branch.
- Worker output is streamed to `events` in near-real-time (not buffered until completion).
- Capabilities discovery works: `worker.capabilities()` returns the actual Claude model in use and a non-fabricated cost-per-token from configuration.
- Crash test: SIGKILL the worker subprocess mid-run. Orchestrator detects via stream-end-without-complete and writes a `failed` event with a synthetic reason.
- Timeout test: Set a 10s deadline, verify orchestrator calls `stop()` and the worktree is cleaned up.

**Scope estimate.** Large. This is where reality meets the abstraction.

**Dependencies.** M2 (worker events need somewhere to land). ADR-0001 must already be merged.

**Open questions.**
- How does the worker stream events back? (Stdout parse vs. file tail vs. Conductor API if exposed — vision question #2.) Pick during M3.
- How is the worktree cleaned up if the orchestrator itself crashes? (Background reaper, or accept leaks for v1?)
- Authentication: how does the spawned `claude` subprocess inherit the OAuth credentials cleanly?

---

## M4 — Decomposition, parallelism, memory retrieval

**Goal.** Manager Agent actually decomposes work into multiple tasks, runs them in parallel under a dependency graph, and synthesizes results. Memory becomes useful (read, not just write).

**Scope.** Manager Agent prompt is upgraded to produce a task graph (N tasks with `depends_on` edges) instead of a single task. Orchestrator runs ready tasks in parallel up to a configurable concurrency limit. Manager receives worker outputs and synthesizes a final result. Add semantic memory retrieval: before each agent call, retrieve top-K relevant memories and inject into context.

**Acceptance criteria.**
- A task that obviously decomposes (e.g., "add a test, then a fixture, then refactor X to use the fixture") runs as ≥3 distinct task rows with correct `depends_on` edges.
- Concurrency cap is honored under load (e.g., 5 ready tasks, cap=2 → at most 2 running at a time).
- The Manager's synthesis pass produces a parent-task result that references its children's outputs.
- Memory retrieval is wired: a planted "we use vitest, not jest" memory steers a downstream worker's choice.

**Scope estimate.** Large.

**Dependencies.** M3.

**Open questions.**
- Concurrency policy default value (vision question #6). Suggest starting at 2 and tuning from real usage.
- How is the memory table populated — automatic extraction from completed tasks, manual seeding, or both? (Probably both; M4 should pick.)
- How does the Manager know when it's "done" and synthesis should fire — explicit termination event from the worker, or graph-completion check?

---

## M5 — Decision router and Slack escalation

**Goal.** Vision Agent becomes a real binary classifier; escalations land in the founder's Slack DM with enough context for a 5-minute decision.

**Scope.** Implement the decision router as a Claude call against the rubric in the vision brief, outputting `{escalate, reason, urgency}`. On `escalate: true`, format a Slack DM with: original task, what the agent wants to do, why this is flagged, links to relevant events/diff, and reply options. The system pauses the affected task branch until a human replies (via Slack reaction or message). Add SMS fallback if Slack reply not received within configurable window.

**Acceptance criteria.**
- A task that touches `auth.*` files triggers an escalation; a task that renames an internal variable does not.
- The Slack DM payload includes everything specified in the rubric and renders cleanly on mobile.
- Operator can resolve an escalation by replying in the Slack thread; the task either resumes or terminates per the reply.
- An escalation pending >N minutes triggers SMS fallback (configurable, defaults TBD).
- All escalation send/receive events land in the `events` table.

**Scope estimate.** Medium.

**Dependencies.** M4. Slack app credentials provisioned by operator (see [escalation-target.md](escalation-target.md)).

**Open questions.**
- Slack escalation message format (vision question #4) — needs design work; suggest one round of iteration during M5.
- Reply parsing: free-form natural language, or a fixed set of reactions/commands? Latter is simpler; former is more honest.
- What's the SMS fallback delay default — 15min? 1hr? Founder preference unknown.

---

## M6 — Budget caps, reliability, issue #97 end-to-end

**Goal.** Ship-readiness. Enforce the per-task and monthly budget caps, harden worker crash/timeout recovery, and run the actual acceptance test: file matome.ai issue #97 and verify all five acceptance criteria hold.

**Scope.** Implement per-task token budget enforcement (cancel-on-exceed, with optional vision-escalation-to-raise instead). Confirm Anthropic Console monthly cap of $500 is active and the orchestrator gracefully degrades when it hits. Add retry policy for worker crashes (N=2 default; configurable). Run the issue #97 dogfood pass; collect notes; fix what breaks. No new features in M6 — only reliability and the acceptance test itself.

**Acceptance criteria.**
- Per-task budget cap: a task exceeding the cap is terminated and surfaced as a `failed` with a `budget_exceeded` reason. Optionally escalates instead.
- Worker crash retry: after a worker fails with crash semantics, orchestrator restarts the same task up to N times before giving up.
- Monthly cap: when Anthropic returns insufficient-credit, orchestrator stops issuing new worker calls and notifies the operator.
- Acceptance test: founder runs the issue #97 command, closes the lid, returns to a reviewable PR on matome.ai with appropriate Slack DMs in the inbox, under $500 spent.

**Scope estimate.** Medium.

**Dependencies.** M5.

**Open questions.**
- Budget-exceeded behavior: terminate vs. escalate to vision for permission to continue? Both valid; the answer depends on how often it fires in practice.
- Retry count default and backoff policy.
- What constitutes "reviewable" for the issue #97 PR — does the orchestrator pre-review/critique its own output, or is that a post-MVP feature?

---

## Cross-milestone notes

- **No GitHub Issues yet.** Milestones are tracked here, not in an issue tracker, per planning-run constraints.
- **Schema (Artifact 2) blocks M2.** WorkerAgent interface (Artifact 3) blocks M1.
- **What's deliberately not a milestone.** Drag-and-drop UI, non-Claude workers, multi-tenancy, cloud backend, web dashboard, nested hierarchies, cost optimization beyond hard caps. All deferred to post-MVP per the vision brief.
- **Risk concentration.** M3 (real worker streaming) and M5 (decision router quality) are where the system is most likely to under-deliver. Both warrant a dedicated dogfooding pass before declaring done.
