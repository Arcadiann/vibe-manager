# vibe-manager

Hierarchical multi-agent orchestrator for software development. A human files a prompt; a Vision Agent (decision router) gates it; a Technical Manager decomposes it into tasks; Claude Code workers execute each task in an isolated git worktree; results land in Postgres and come back as one reviewable PR. See `docs/vision.md` for the product brief and `docs/decisions/` for the architecture of record (ADR-0001 worker contract, ADR-0002 auth, ADR-0003 persistence, ADR-0004 runtime).

## Quickstart (zero → first run, ~15 min)

```sh
# 1. Toolchain
corepack enable || npm i -g pnpm
pnpm install

# 2. Configure — every var is commented in the template
cp .env.example .env   # fill in ANTHROPIC_API_KEY + DATABASE_URL (session mode, port 5432)

# 3. Apply the schema to your Supabase project (once)
supabase login && supabase link --project-ref <your-project-ref>
supabase db push        # applies supabase/migrations/0001_vibe_manager_init.sql
#   (or: psql "$DATABASE_URL" -f supabase/migrations/0001_vibe_manager_init.sql)

# 4. Verify everything BEFORE spending tokens
pnpm vibe doctor --repo /path/to/target-repo

# 5. Run
pnpm vibe run "add a CONTRIBUTING.md describing dev setup" --repo /path/to/target-repo
```

`vibe run` preflights (claude binary, gh auth, DB, repo, Slack), prints the `root_task_id` immediately, holds a `caffeinate` power assertion for the run, and executes in the foreground. **Walk-away daemonization (lid closed) is not built yet** — that's its own milestone; until then a crashed/killed run leaves detached workers running until the next `vibe` invocation reaps them (spend bounded by your per-key cap).

## Operating it

```sh
pnpm vibe status            # dashboard: recent runs, $ spent vs caps, failures inline, escalations
pnpm vibe status <root_id>  # one run's task tree
pnpm vibe log <root_id>     # ordered event narrative (the events table, readable)
pnpm vibe stop [--hard]     # kill switch: end the daemon + its workers, mark tasks cancelled
pnpm vibe reap              # clean orphaned workspaces (also runs at every vibe run start)
pnpm vibe doctor            # all preflight checks, spend nothing
```

Failed/timed-out tasks keep their worktree under `~/.vibe-manager/workspaces/` for post-mortem (`vibe reap --include-preserved --yes` deletes them).

Hardware note for unattended runs: macOS sleeps on lid close unless on power with an external display (clamshell). `caffeinate` covers idle-sleep only.

## Tests

```sh
pnpm test                 # unit + local-integration (real git repos, real process groups)
pnpm typecheck
RUN_EVALS=1 pnpm test     # + labeled prompt evals against the real API (~cents)
VIBE_TEST_DATABASE_URL=... pnpm test   # + migration behavior tests (DISPOSABLE db — applies down+up)
RUN_INTEGRATION_TESTS=1 pnpm test      # + real claude-subprocess worker test
```

## Layout

```
src/runtime/        WorkerRuntime + GitWorktreeRuntime (ADR-0004: workspaces, process groups, reaper)
src/workers/        WorkerAgent contract + ClaudeCodeWorker (ADR-0001/0002: protocol, env allowlist)
src/agents/         VisionAgent (router) + ManagerAgent (decompose/synthesize) + JSON-call helper
src/orchestrator/   dispatcher (task loop, budget floor, zombie rule, PR opening) + escalation
src/persistence/    pg pool/retry, repos, TASK_STATUSES (drift-tested against the migration)
src/cli/            vibe — run/status/log/stop/reap/doctor
supabase/migrations ADR-0003 schema (as amended)
```

Conductor note: Conductor is the founder's development environment for this repo. It is **not** in the runtime path (ADR-0004) — vibe-manager owns its worktree/sandbox lifecycle.
