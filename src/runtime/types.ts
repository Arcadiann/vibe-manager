// WorkerRuntime — the placement layer defined in ADR-0004.
//
// WorkerAgent (ADR-0001) is the *protocol* layer: CLI args, env allowlist,
// envelope parsing, WorkerEvent emission, stop-grace policy. WorkerRuntime is
// the *placement* layer: where code runs and how processes die — workspace
// create/teardown, spawn, process-group signaling, crash-orphan reaping.
// The worker is constructed with a runtime and calls runtime.exec() instead of
// child_process.spawn; the dispatcher provisions workspaces and never learns
// `claude`'s arguments; the worker never learns git.
//
// HONESTY CLAUSE (ADR-0004): this interface is local-process-shaped (pid,
// POSIX signals, Node streams). It is a seam, not a portability contract — a
// future CloudSandboxRuntime WILL force a revision. The one portability
// property we claim: callers contain no child_process or git knowledge, so the
// revision is contained to this layer.

export type WorkspaceSpec = {
  taskId: string
  baseRepoPath: string
  // REQUIRED — e.g. 'origin/main' after a fetch, or a local ref/SHA. Never
  // implicit HEAD: the operator's checkout state (feature branch, mid-rebase)
  // must never silently become a task's substrate.
  baseRef: string
  // Branch is `vibe/<taskId>-a<attempt>` — retry-safe after preserve-on-
  // failure kept the previous attempt's branch alive. An existing branch of
  // the same name is a hard error, never silent reuse.
  attempt: number
}

export type WorkspaceHandle = {
  id: string
  path: string
  branch: string
}

export type ExecSpec = {
  command: string
  args: string[]
  // Passed to the child VERBATIM — never merged with process.env, never
  // logged (it carries ANTHROPIC_API_KEY). The worker tier's allowlist
  // (ADR-0002) is the sole author of this env; the runtime is a dumb pipe.
  env: Record<string, string>
  cwd?: string
}

export type ExecExit = {
  // null exitCode means signal-death; `signal` then carries the name. The
  // worker maps this to terminationMode / failure reasons.
  exitCode: number | null
  signal: string | null
}

export interface ExecHandle {
  pid: number | null
  pgid: number | null
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  // Resolves on child EXIT (not stream close — detached grandchildren can
  // inherit the stdio pipes and hold them open indefinitely). The runtime
  // drains stdio for a bounded grace after exit so callers see complete
  // output in the normal case and a bounded delay in the grandchild case.
  // REJECTS on pre-exec failure (e.g. spawn ENOENT) so spawn errors have a
  // typed channel instead of vanishing.
  wait(): Promise<ExecExit>
  // group: true signals the process group (-pgid). ESRCH-tolerant: returns
  // false when there is nothing left to signal.
  signal(sig: 'SIGTERM' | 'SIGKILL', opts?: { group?: boolean }): boolean
}

export type TeardownOptions = {
  // Preserve the workspace for post-mortem (used for failed/timed_out tasks).
  // Writes a `.vibe/preserved` marker the reaper respects.
  preserve?: boolean
}

export type ReapOptions = {
  // Also reap workspaces carrying the `.vibe/preserved` post-mortem marker.
  includePreserved?: boolean
}

export type ReapReport = {
  workspaceId: string
  taskId: string | null
  path: string
  // What the reaper did about the recorded process, if any.
  process: 'killed' | 'already-dead' | 'pid-reused-not-touched' | 'none-recorded'
  removed: boolean
  preservedSkipped: boolean
  // Set when this workspace's reap failed; other workspaces proceed anyway.
  error?: string
}

export interface WorkerRuntime {
  createWorkspace(spec: WorkspaceSpec): Promise<WorkspaceHandle>
  exec(ws: WorkspaceHandle, spec: ExecSpec): Promise<ExecHandle>
  teardown(ws: WorkspaceHandle, opts?: TeardownOptions): Promise<void>
  listWorkspaces(): Promise<WorkspaceHandle[]>
}
