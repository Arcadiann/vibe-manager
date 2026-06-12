# ADR-0004: Decouple Worker Runtime from Conductor — the `WorkerRuntime` Interface

- Status: Proposed (operator checkpoint pending — issue #50)
- Date: 2026-06-11
- Supersedes: the "Worker tier (v1): Wrap Claude Code via Conductor worktrees" row of `docs/vision.md`'s locked-scope table (file edit deferred, same pattern as ADR-0002's supersession of the billing row; tracked with #31-class cleanup)

## Context

The vision brief locked the v1 worker tier as "wrap Claude Code via Conductor worktrees — leverage mature tooling; replace later when forced." We are now forced, earlier than expected: Conductor is moving to cloud sandboxes and deprecating the local-worktree abstraction Vibe Manager's runtime was assumed to inherit. More fundamentally, a product whose runtime depends on its founder's IDE-layer tooling can never become the Version-C SaaS — the decoupling is right even if the deprecation timeline slips.

Investigation of the worker tier as merged found the coupling is **not in code**. `ClaudeCodeWorker` (`src/workers/claude-code-worker.ts`) spawns `claude` directly with `cwd = spec.workingDirectory`; there is no Conductor invocation, no Conductor IPC, anywhere in `src/`. The coupling lives in three non-code places:

1. ADR-0001 §"How `ClaudeCodeWorker` satisfies the interface" described a Conductor-worktree-creating worker that was never built (drift tracked as #16).
2. `docs/vision.md`'s locked-scope row, superseded by this ADR.
3. The real gap: **nothing owns the workspace lifecycle.** The orchestrator was going to inherit Conductor's worktrees by assumption.

This is the moment to fix it: the orchestrator tier is greenfield, so the runtime layer can be poured under it rather than retrofitted.

**Critical distinction.** Conductor remains the founder's development environment — this repo is developed inside Conductor workspaces. Conductor is removed from *Vibe Manager's runtime path*: no Vibe Manager process may shell out to Conductor, depend on its IPC, or assume its worktree conventions at runtime.

## Decision

Vibe Manager owns its workspace/sandbox lifecycle behind a `WorkerRuntime` interface. The v1 implementation is `GitWorktreeRuntime` (local `git worktree` + local processes). Conductor is explicitly out of the runtime path.

### Division of responsibility

- **`WorkerAgent`** (ADR-0001) stays the *protocol* layer: CLI args, env allowlist policy, result-envelope parsing, `WorkerEvent` emission, stop-grace policy. One additive change to ADR-0001's types is required (see §Interface — `WorkerContext.workspace`).
- **`WorkerRuntime`** is the *placement* layer: where code runs and how processes die. Workspace create/teardown, process spawn, process-group signaling, crash-orphan reaping.
- The worker is constructed with a runtime and calls `runtime.exec()` instead of `child_process.spawn`. The dispatcher provisions workspaces and never learns `claude`'s arguments; the worker never learns git.

### Interface

```ts
type WorkspaceSpec = {
  taskId: string
  baseRepoPath: string
  // REQUIRED. e.g. 'origin/main' after a fetch — never implicit HEAD. The founder's
  // checkout state (feature branch, mid-rebase) must never become a task's substrate.
  baseRef: string
  // Branch is `vibe/<taskId>-a<attempt>`: retry-safe after preserve-on-failure.
  // An existing branch of the same name is a hard error, never silent reuse.
  attempt: number
}
type WorkspaceHandle = { id: string; path: string; branch: string }

type ExecSpec = { command: string; args: string[]; env: Record<string, string>; cwd?: string }

interface ExecHandle {
  pid: number | null
  pgid: number | null
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  // Resolves on child EXIT, not stream close — detached grandchildren can inherit
  // the pipe and hold it open indefinitely. The runtime drains stdio for a bounded
  // grace (~2s) after exit and group-kills stragglers. Signal-death is reported
  // distinctly (the worker maps it to `terminationMode`). REJECTS on pre-exec
  // failure (e.g. ENOENT) so spawn errors have a typed channel.
  wait(): Promise<{ exitCode: number | null; signal: string | null }>
  signal(sig: 'SIGTERM' | 'SIGKILL', opts?: { group?: boolean }): boolean
}

interface WorkerRuntime {
  createWorkspace(spec: WorkspaceSpec): Promise<WorkspaceHandle>
  exec(ws: WorkspaceHandle, spec: ExecSpec): Promise<ExecHandle>
  teardown(ws: WorkspaceHandle, opts?: { preserve?: boolean }): Promise<void>
  listWorkspaces(): Promise<WorkspaceHandle[]>   // reaper support
}
```

**Additive ADR-0001 touch.** The worker needs the `WorkspaceHandle` to call `exec()`; `TaskSpec.workingDirectory` is a bare string. `WorkerContext` gains an optional field:

```ts
type WorkerContext = {
  env: Record<string, string>
  workspace?: WorkspaceHandle   // additive; supplied by the dispatcher when a runtime is in play
}
```

Fabricating handles from paths or hiding a path→handle lookup inside the runtime were both rejected — dishonest typing now costs more later. ADR-0001's reconciliation records this as an accepted additive extension.

### `GitWorktreeRuntime` (v1 backend)

- **createWorkspace:** `git fetch` then `git worktree add -b vibe/<taskId>-a<attempt> <dir> <baseRef>`, run with `-c core.hooksPath=/dev/null` and a scrubbed env (see §Security). A per-baseRepo async mutex serializes worktree operations (`git worktree add` contends on repo-level locks).
- **exec:** spawns detached in a fresh process group (`detached: true` + own pgid). At spawn time the runtime persists `{pid, pgid, processStartTime}` to `<workspace>/.vibe/proc.json` — the crash-durable registry.
- **Signal escalation (honors ADR-0001's strengthened `stop()` contract):** `kill(-pgid, SIGTERM)` (group from the first signal) → on leader exit or grace expiry → `kill(-pgid, SIGKILL)`, ESRCH-tolerant. Group-first signaling minimizes the pgid-reuse window between leader death and group kill; the residual TOCTOU is accepted and documented. This closes #15: grandchildren (Claude Code's tool subprocesses) die with the group.
- **Orphan safety (the reason the current worker refused `detached: true`):** moves from "stay in the daemon's process group" to three layers — (1) daemon `SIGINT`/`SIGTERM` handlers walk live handles and group-kill; (2) `.vibe/proc.json` survives daemon SIGKILL/OOM/power-loss; (3) the reaper (`vibe reap`, also on daemon start) reads proc files via `listWorkspaces()`, **validates pid identity by process start-time before `kill(-pgid)`** (never trusts a possibly-reused pid), then tears down and transitions the task row to `failed` (reason `orphan_reaped`) so operator-visible state never lies after a crash.
- **teardown:** poll `kill(-pgid, 0)` until ESRCH (bounded) → `git worktree remove --force` (a dirty worktree is the *normal* post-task state) → `git branch -D` (after removal — order matters) → reaper additionally runs `git worktree prune` for stale metadata. `preserve: true` (used for `failed`/`timed_out` post-mortems) writes `<workspace>/.vibe/preserved`; the reaper skips marked workspaces unless explicitly told otherwise (`--include-preserved`, which lists and confirms).
- **Env contract:** `ExecSpec.env` is passed to the child **verbatim — never merged with `process.env`, never logged** (it carries `ANTHROPIC_API_KEY`). A runtime test spawns `env` and asserts the child environment equals exactly `ExecSpec.env`. The worker tier's allowlist (ADR-0002, issue #8/#9 lineage) remains the sole author of that env; the runtime is a dumb pipe. The concrete worker env is the existing `WORKER_ENV_ALLOWLIST` (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_ALL`, `TMPDIR`, `TZ`) plus the injected `ANTHROPIC_API_KEY` — and integration tests run with this production allowlist, not a test-convenience env.

### Honesty clause: this interface is local-process-shaped

`ExecHandle` exposes `pid`, POSIX signals, and Node streams. A future `CloudSandboxRuntime` has none of those — it has remote sessions, network streams, auth, and latency. **This interface is a seam, not a portability contract.** When a cloud backend is built, the interface WILL be revised (likely around session handles and event channels); ADR-0001's "stream transport" open question stays open and is unchanged by this ADR. We claim exactly one portability property: the *callers* (worker protocol layer, dispatcher) contain no `child_process` or `git` knowledge, so the revision is contained to the runtime layer.

### Security

- **`git worktree add` executes repo-configured hooks** (`post-checkout`, `core.hooksPath`) — arbitrary code execution from target-repo content in the daemon's environment, a strictly worse surface than the worker's allowlisted env. Mitigation: all runtime git commands run with `-c core.hooksPath=/dev/null` and a scrubbed env.
- **Orchestrator-tier agents read target-repo content** (Manager decomposition, synthesis). This project's own history includes a prompt-injection incident (vision.md, cleaned in PR #5). v1 accepts the risk because target repos are founder-owned; the M-scale mitigation (content/instruction separation in agent prompts) is named here so it is a decision, not an accident.
- **Accepted exposure until daemonization lands:** with workers detached, a daemon crash during a walk-away run means unsupervised spend until human return (recovery on next daemon start via the reaper; bounded by ADR-0002's per-key caps). A launchd `KeepAlive` supervisor is the planned fix, tracked as a deferral issue.

## How the salvaged worker changes (step 2 scope; reuse, not rewrite)

- Constructor takes a `WorkerRuntime`; `buildSpawnPlan` becomes an `ExecSpec` builder; `start()` calls `runtime.exec(ctx.workspace, spec)`.
- `stop()` keeps its policy (grace window, idempotency, `terminationMode` mapping) and delegates the mechanics to `ExecHandle.signal(..., { group: true })`.
- All 37 existing tests keep passing: the `SpawnFn` injection seam becomes a fake-`ExecHandle` seam — the same testing pattern one level up.
- Everything else — env allowlist, envelope parsing, heartbeats, `is_error` mapping, tokens extraction — is untouched.

## Alternatives considered

1. **Inline worktree helper, no interface (minimal viable).** A git-worktree module called directly by the dispatcher; worker keeps spawning via `child_process`. Rejected: process ownership stays inside the worker, so #15's orphan-vs-grandchild tension is unresolvable cleanly; placement logic smears across two layers; a cloud backend later forces the interface anyway *plus* a worker re-plumb at the worst time (post-orchestrator).
2. **Runtime owns the full session including streaming transport (ideal-architecture).** `exec` returns a remote-able event channel; worker becomes a pure parser. Rejected: rebuilds the worker streaming internals that just stabilized across 9 PRs and answers ADR-0001's stream-transport question before being forced — premature per the MVP's "learn which abstractions are real" purpose.
3. **Claude Agent SDK as the worker transport** (the mission names it as an option). Structured streaming events and incremental usage would eliminate the envelope-parsing fragility class (#17/#22/#26/#27 lineage) — but at the cost of rewriting the hardened subprocess worker, which trips this run's "abandon the salvage" stop condition. Rejected *for this run*; a spike issue records the trigger criteria (when #26-class needs or envelope-pinning pain justify the rewrite). This is now a recorded decision, not an accident of history.
4. **Keep assuming Conductor worktrees.** Rejected: deprecating substrate, founder-tool coupling, and the SaaS arc all point one way.

## Consequences

**Positive.** Conductor out of the runtime path; #15 closed properly (group-kill without orphan risk); worktree lifecycle finally owned, with crash-durable accounting; the cloud seam exists where Version C needs it; the worker salvage preserves 9 PRs of hardening.

**Negative / tradeoffs.** One more interface to maintain, and an honest promise to revise it for cloud; detached processes shift orphan-safety from "free" (process group death) to "engineered" (proc.json + reaper + supervisor), which is more code and three new failure-shaped tests; `WorkerContext` gains a field, so ADR-0001 is touched (additively) one release after being Accepted.

## References

- Issue #50 — plan checkpoint for this run (review trail, decisions UC1/UC2/T1/T4/T5).
- Issue #15 — `stop()` grandchild leak; closed by the GitWorktreeRuntime design above (implementation in step 2).
- [ADR-0001](0001-worker-agent-interface.md) — protocol contract this ADR layers under; reconciled and Accepted in the same PR.
- [ADR-0002](0002-worker-auth-api-key.md) — env/credential contract the runtime's verbatim-env rule preserves.
- `docs/vision.md` — superseded scope-table row (file edit deferred; see Supersedes above).
