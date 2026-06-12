# Advisor context

Canonical state-of-the-project handoff for the technical advisor. Read this first; it points at the ADRs and issues that hold the real detail.

## Project snapshot

Vibe Manager is a hierarchical multi-agent orchestrator for software development: a human operator describes a product vision, a Vision Agent routes decisions (escalate/proceed), a Technical Manager Agent decomposes work and delegates to Claude Code worker agents in isolated git worktrees, results flow back up as one reviewable PR, and the human is pinged (Slack DM) only for vision-affecting decisions. v1 scope is locked per `docs/vision.md`; the acceptance target is matome.ai issue #97 shipping end-to-end with the laptop in clamshell mode.

**As of the 2026-06-11/12 "re-pour" run (plan checkpoint: issue #50), all three tiers exist in code.** The foundation was deliberately re-poured before the orchestrator landed: Conductor — which is the founder's *development environment* for this repo — is explicitly **out of the runtime path** (ADR-0004). Vibe Manager owns its workspace/process lifecycle behind a `WorkerRuntime` interface with a local `GitWorktreeRuntime` backend. The remaining gap to a live end-to-end run is operator credentials only: no `ANTHROPIC_API_KEY` or `DATABASE_URL` exists on the build machine, so the schema has not been applied to Supabase and the smoke test has not executed. **#56 is the smoke-test runbook** — ~15 minutes of operator time unblocks it.

## Architecture-of-record

- **ADR-0001 — WorkerAgent Interface Contract** (status: **Accepted**, 2026-06-11). The five-method worker contract + `WorkerEvent` taxonomy. Reconciled against the merged implementation in the same pass that accepted it (drift issues #10/#16/#22/#30 closed); documents the shipped additive extensions (cache-token fields, `failed.payload`/`terminationMode`) and one further additive change from ADR-0004: `WorkerContext.workspace?: WorkspaceHandle`. **Constraint:** the orchestrator never touches a model SDK for *workers*; every worker speaks this event vocabulary; the orchestrator decides what failures mean.
- **ADR-0002 — Worker auth via `ANTHROPIC_API_KEY`** (status: Accepted). Unchanged. The worker env allowlist now also explicitly excludes publish credentials (`GH_TOKEN`/`SSH_AUTH_SOCK`) — pushing and PR-opening is the dispatcher's job from the daemon env.
- **ADR-0003 — Persistence Schema** (status: **Proposed, amended 2026-06-11**). Amendment (merged PR #52) resolved gates #33/#41–#47 (embedding model record + OpenAI-dependency note, numeric(20,8) spend, idempotency_key, GUC-gated append-only trigger, RLS disable, `events.dedupe_key`, WAN write-failure posture, secrets-at-rest note, migration tooling = Supabase CLI + plain SQL). **Still parked, so the ADR stays Proposed: #34 (events retention), #36 (summarizer timing), #37 (soft-delete)** — each needs a running orchestrator or dogfood data. The migration (`supabase/migrations/0001_vibe_manager_init.sql`, merged PR #54) implements the amended schema; **it has not yet been applied** (no DATABASE_URL on the machine).
- **ADR-0004 — Decouple Worker Runtime from Conductor** (status: **Accepted**, 2026-06-12). `WorkerRuntime` (createWorkspace/exec/teardown/listWorkspaces) is the placement layer; `WorkerAgent` stays the protocol layer. `GitWorktreeRuntime` is the v1 backend: explicit-baseRef worktrees, detached process groups, crash-durable `proc.json` + start-time-validated reaper (closes the #15 grandchild leak), `hooksPath=/dev/null`, verbatim-env rule. **Honesty clause:** the v1 interface is local-process-shaped — a seam, not a portability contract; a cloud backend will revise it. The Claude Agent SDK is a recorded, rejected-for-now alternative (spike: #58). Supersedes vision.md's "via Conductor worktrees" row (file edit queued as #60).

## Tier status (all code merged to main; tests 78/78 + gated suites)

- **Runtime** (`src/runtime/`, PR #53): implemented + integration-tested with real git repos and real process groups (orphan reap after daemon loss, pid-reuse protection, dirty teardown, env-verbatim, grandchild group-kill, exit-not-close wait).
- **Worker** (`src/workers/`, adapted in PR #53): the hardened `ClaudeCodeWorker` salvaged intact behind the runtime; group-first stop escalation; status()/stream() agreement on envelope failures; stop-contract enforcement (no tokens after stop, even on trap-SIGTERM-exit-0). Still the **low-fidelity** token path (#26 is the stream-json upgrade and is also what makes the router's mid-run trigger live).
- **Agents** (`src/agents/`, PR #55): VisionAgent (Haiku 4.5; vision-brief rubric verbatim; both trigger points wired, mid-run one dormant until #26; every decision persisted with full rubric I/O — the escalation ground-truth dataset starts at run #1), ManagerAgent (Sonnet 4.6; validated-DAG decomposition + PR synthesis), `claudeJsonCall` (structured outputs + repair-retry-once-then-loud-fail).
- **Orchestrator** (`src/orchestrator/`, PR #55): sequential topological dispatcher with sequential branch lineage (each task builds on the previous task's branch; per-edge isolation returns at M4a), crude budget floor ($20/task default, post-hoc — real enforcement is #26+M6), ADR-0001 zombie rule, synthetic-terminal contract, preserve-on-failure teardown (completed workspaces torn down only after the PR is opened), dispatcher-owned push/`gh pr create`, Slack escalation surface (fire-and-record; reaction loop is M5).
- **CLI** (`src/cli/vibe.ts`, PR #55): `run` (preflight before any LLM spend, pidfile guard, caffeinate, startup reap that fixes DB rows), `status` (dashboard: runs, dollars vs the $500 cap, failures inline, escalations), `log`, `stop [--hard]`, `reap [--include-preserved]`, `doctor`. **Foreground only** — walk-away daemonization is #62.

## Open issues triage

**Operator-blocking:** #56 (smoke test runbook — needs `ANTHROPIC_API_KEY` + `DATABASE_URL`; everything downstream of "does it actually run" waits on this).

**P2 worker tier (pre-existing):** #19/#20 (test-coverage gaps on stream failure paths and stop/status lifecycle — partially superseded by the runtime-era suites; re-triage), #18 (non-zero-exit stdout discarded from diagnostics), #27 (envelope-shape integration pin).

**Next architectural beats:** #57 (real-issue decomposition/router evals — do before M4a; if decomposition quality is poor, M4a's design changes), #26 (stream-json: high-fidelity tokens + live mid-run router trigger), #61 (retry policy), #62 (daemonization/walk-away), #63 (tail/replay), #59 (shadow-mode escalation logging — the defensible-asset play).

**Cleanups:** #60 (vision.md drift: #31/#32 + the Conductor row), #64/#65 (runtime signal/drain edges from review), #66 (origin/master default-branch detection), #21 (capabilities env declaration — still parked on orchestrator credential-broker shape), #49 (handoff procedure), #34/#36/#37 (parked ADR-0003 gates).

## Recently merged (this run, newest first)

- **#55 — orchestrator skeleton** (closes #38). Persistence + agents + dispatcher + CLI; 78 tests; two adversarial-review passes caught a run-killing teardown-before-push bug, silent PR data loss on non-linear graphs, a 3x pricing error in the budget floor, and stranded-state bugs on agent throws — all fixed pre-merge.
- **#54 — migration 0001** (closes #35, #41, #42, #47). The amended ADR-0003 schema as SQL; DB-backed tests gated on a disposable database.
- **#53 — WorkerRuntime + GitWorktreeRuntime; worker adaptation** (closes #15). The decouple itself; 59 tests at merge incl. failure-shaped runtime suites.
- **#52 — ADR-0003 amendments** (closes #33, #43, #44, #45, #46).
- **#51 — ADR-0004 + ADR-0001 reconciliation → Accepted** (closes #10, #16, #22, #30).
- **#50 — plan checkpoint issue** (still open as the run's record; operator approved "proceed as recommended" — UC1 build order kept, UC2 interface kept with honesty clause, T1 approach A, T4 sequential lineage, T5 CLI scope, SQL gates as recommended).

## Working agreements with the advisor

Unchanged: GitHub Issues are the source of truth; one issue per workspace; PRs off `origin/main` with clean worktrees; plan-first review for architecture/schema/destructive changes; stop conditions are mandatory. One precedent from this run: the operator may explicitly authorize a single PR closing a set of issues that share a root cause (the ADR-0001 drift set in #51) — flag it in the PR body when it happens. Codex CLI is unusable on the build machine (account/model rejection); gstack dual-voice reviews run as independent Claude subagents.

## Common failure modes the advisor watches for

All previous entries stand (env-leakage, silent-success envelope parsing, ADR drift, scope creep). New ones from this run:

- **Teardown-vs-publish ordering.** Completed workspaces must outlive the push/PR step — teardown deletes the branch. Any dispatcher change that "cleans up earlier" reintroduces the P1 the review caught.
- **Branch lineage vs decomposition shape.** The skeleton pushes ONE branch; sequential lineage guarantees it contains all completed work. Any change to per-edge isolation before M4a's integration-branch design silently drops sibling work from the PR.
- **Spend math trusts `capabilities()`.** The budget floor and the $-dashboard multiply token counts by the worker's cost table; a stale price silently distorts enforcement 3x (it happened — review P2-6). Re-verify against the current model catalog when bumping models.
- **Session-mode Postgres only.** Supavisor transaction pooling (port 6543) breaks session state; `vibe doctor` rejects it — keep it that way.
- **The pidfile is not identity.** Always verify a pid looks like a vibe daemon (`ps -o command=`) before signaling; the runtime's `proc.json` start-time validation is the same principle for workers.

## What's next

1. **Operator: #56** — provision the two secrets, apply the migration, run the smoke test (runbook in the issue; ≤ ~$2). This is the run's acceptance criterion and everything else queues behind the evidence it produces.
2. **#57 real-issue evals** before M4a — the thesis check both review voices asked for.
3. Then the milestone ladder resumes: #26 (high-fidelity tokens + live mid-run routing) → #61 (retries) → M4a (concurrency + DAG integration branches) → #62 (walk-away daemonization) → M5 (Slack reaction loop) → M6 (budget enforcement + issue #97 acceptance).

## How to update this doc

Every PR that materially changes the architecture-of-record (new ADR accepted or superseded), any tier's implemented-vs-stubbed status, or the open-issue triage list should include a corresponding edit to this file as part of its diff. Treat it the same as updating a CHANGELOG: not optional, not a separate follow-up. Future workspace prompts should reference this doc at investigation step 1, alongside reading the relevant ADRs in full.
