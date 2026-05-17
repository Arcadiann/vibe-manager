The vision.md file isn't on disk. I'm going to give you the content directly. Please create the file at docs/vision.md with exactly the following content (replace the .gitkeep currently in docs/, but keep .gitkeep files in docs/decisions/ and docs/planning/ intact):

```
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
```

After creating the file, commit on Arcadiann/london with the message "Add vision brief" and push to main via:

git push origin Arcadiann/london:main

Confirm the file is in docs/, the commit succeeded, and the push completed.