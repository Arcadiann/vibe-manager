# Smoke run 0001 — end-to-end acceptance (plan #50 step 4, runbook #56)

**Date:** 2026-06-12 · **Result: PASS** (attempt 3) · **Spend: $0.06 for the passing run** ($1.37 month-to-date including failed attempts and evals)

One real prompt flowed top to bottom with **no Conductor anywhere in the runtime path**:

```
pnpm vibe run "Add a CONTRIBUTING.md describing how to set up the dev environment and
submit changes, then add a Contributing section to README.md that links to it." \
  --repo /tmp/vibe-smoke-target --timeout-min 15
```

| Acceptance criterion (plan §6) | Evidence |
|---|---|
| CLI accepts one command | `vibe run` above; preflight passed before any LLM spend |
| VisionAgent classifies | `router_decision` event: *proceed* — "Documentation additions … routine implementation tasks … No product direction change, no security/auth/billing surface" (full rubric I/O persisted) |
| ManagerAgent decomposes into ≥2 tasks | 2 tasks with a dependency edge (`task_decomposed`, `task_dependencies` row) |
| Full tree executes via real workers | Both tasks ran as real `claude` subprocesses in `GitWorktreeRuntime` worktrees (`vibe/6e6d6632…-a0`, then `vibe/09d39a94…-a0` branched from the first — sequential lineage) |
| Result + events land in Postgres | 18-event causal chain in `vibe_manager.events`; task rows `complete` with per-task spend (3.6¢ + 2.4¢) |
| A PR is opened | <https://github.com/Arcadiann/vibe-smoke-target/pull/1> — Manager-synthesized title/body; both tasks' commits on one branch |

Event spine (heartbeats elided):

```
21:50:12 task_created        root
21:50:14 router_decision     vision   proceed (reason persisted)
21:50:26 task_decomposed     manager  2 tasks
21:50:27 task_dispatched     → claude-code in vibe/6e6d6632…-a0
21:50:48 worker_event:tokens / worker_event:complete
21:50:49 task_status_change  complete
21:50:49 task_dispatched     → claude-code in vibe/09d39a94…-a0   (baseRef = previous branch tip)
21:51:06 worker_event:tokens / worker_event:complete
21:51:07 task_status_change  complete
21:51:15 synthesis           manager  PR title/body
21:51:19 pr_opened           https://github.com/Arcadiann/vibe-smoke-target/pull/1
21:51:19 run_completed       complete
```

## What the failed attempts taught (each produced a shipped fix)

1. **Attempt 1 — workers "completed" having written nothing.** Headless `claude -p` cannot answer permission prompts, so every Write/Edit was silently denied; the workers exited cleanly, empty branches were pushed, and `gh pr create` failed far from the cause ($1.22 spent). Fixes: `--dangerously-skip-permissions` in the worker exec spec (the worktree + env allowlist is the isolation boundary, not per-tool prompts) **and** a dispatcher guard — a `complete` task whose branch has zero commits over its base is now `failed: no_changes_committed`.
2. **Attempt 2 — worker escaped its worktree.** The dispatcher passed the absolute repo path as Manager context; the Manager embedded it in a task description; the worker followed it and committed to the *original clone* instead of its isolated workspace (caught immediately by the new no-commit guard, 8.5¢). Fixes at three layers: repo *name* only to the Manager, relative-paths-only rule in the decompose prompt, and an isolation preamble in every rendered worker prompt. The contaminated clone was hard-reset.
3. **Attempt 3 — PASS**, with one cosmetic wart: the worker's `git add -A` swept the runtime's `.vibe/` metadata into the PR. Fixed post-run: `createWorkspace` now registers `.vibe/` in the repo's `info/exclude` (regression-tested); PR #1 retains the two stray files as an artifact of the passing run.

Also fixed en route to the run: Supabase direct connections are IPv6-only and unreachable from this network — `DATABASE_URL` moved to the session pooler (`aws-1-us-east-2.pooler.supabase.com:5432`, still session semantics), and `createPool` now enables TLS for Supabase hosts.

## Reproduce / clean up

The runbook lives in issue #56. Cleanup once reviewed: `gh repo delete Arcadiann/vibe-smoke-target --yes` and `pnpm vibe reap --include-preserved --yes` (one preserved post-mortem workspace from attempt 2 remains by design).
