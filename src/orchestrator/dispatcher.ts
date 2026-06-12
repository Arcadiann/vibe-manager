import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { WorkerAgent, TaskSpec, WorkerEvent } from '../workers/types.ts'
import { HEARTBEAT_INTERVAL_MS } from '../workers/claude-code-worker.ts'
import { buildSpawnEnv, resolveApiKey } from '../workers/claude-code-worker.ts'
import type { WorkerRuntime, WorkspaceHandle } from '../runtime/types.ts'
import type { TasksRepo, EventsRepo, TaskRow } from '../persistence/repos.ts'
import type { VisionAgent } from '../agents/vision-agent.ts'
import type { ManagerAgent } from '../agents/manager-agent.ts'
import { raiseEscalation } from './escalation.ts'

const execFileAsync = promisify(execFile)

// Port types (method-only views of the concrete classes) so tests can inject
// in-memory fakes without inheriting private fields.
export type TasksPort = Pick<
  TasksRepo,
  'createRoot' | 'createChild' | 'addDependency' | 'setStatus' | 'recomputeSpend' | 'get'
>
export type EventsPort = Pick<EventsRepo, 'append' | 'spentCentsFor'>
export type VisionPort = Pick<VisionAgent, 'classify'>
export type ManagerPort = Pick<ManagerAgent, 'decompose' | 'synthesize'>

export type DispatcherDeps = {
  runtime: WorkerRuntime
  worker: WorkerAgent
  tasks: TasksPort
  events: EventsPort
  vision: VisionPort
  manager: ManagerPort
  env: {
    anthropicApiKey: string
    slackWebhookUrl?: string
  }
  log?: (line: string) => void
}

export type RunOptions = {
  prompt: string
  repoPath: string
  baseRef?: string // default origin/main; falls back to main for remoteless repos
  // Crude budget floor (plan §5 / review F8): wall-clock cap + post-hoc check
  // on the completion-time tokens event. The real mid-run enforcer is #26.
  taskTimeoutMs?: number
  taskBudgetCents?: number
  openPr?: boolean
}

export type RunOutcome = {
  rootTaskId: string
  status: 'complete' | 'failed' | 'blocked'
  prUrl?: string
  taskSummaries: Array<{ id: string; title: string; status: string; summary: string }>
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_BUDGET_CENTS = 2000 // $20/task default per vision.md rubric

export async function runRoot(deps: DispatcherDeps, opts: RunOptions): Promise<RunOutcome> {
  const log = deps.log ?? ((l: string) => console.error(l))
  const root = await deps.tasks.createRoot({
    title: opts.prompt.slice(0, 120),
    description: opts.prompt,
  })
  await deps.events.append({
    kind: 'task_created',
    taskId: root.id,
    rootTaskId: root.id,
    payloadSummary: `root: ${root.title}`,
  })

  // ── Router, trigger 1: inbound prompt (sanity gate). Every decision is
  // persisted with its full rubric input — escalation ground truth from run #1.
  const routed = await deps.vision.classify({ trigger: 'inbound_prompt', prompt: opts.prompt })
  await deps.events.append({
    kind: 'router_decision',
    taskId: root.id,
    rootTaskId: root.id,
    agent: 'vision',
    payload: { trigger: 'inbound_prompt', input: routed.rubricInput, decision: routed.decision, usage: routed.usage },
    payloadSummary: `${routed.decision.escalate ? 'ESCALATE' : 'proceed'}: ${routed.decision.reason}`,
  })
  if (routed.decision.escalate) {
    await raiseEscalation({
      events: deps.events,
      rootTaskId: root.id,
      taskId: root.id,
      decision: routed.decision,
      context: `Inbound prompt: ${opts.prompt}`,
      webhookUrl: deps.env.slackWebhookUrl,
    })
    await deps.tasks.setStatus(root.id, 'blocked', { reason: routed.decision.reason })
    return { rootTaskId: root.id, status: 'blocked', taskSummaries: [] }
  }

  // ── Manager: decompose into the task graph. A throw (graph_invalid,
  // llm_output_invalid) must not strand the root row in 'pending' (P2-5).
  let decomposition, order
  try {
    // Repo context is the NAME only — never the absolute path. Smoke run #56
    // attempt 2: the Manager embedded the path in a task description and the
    // worker wrote to the ORIGINAL clone instead of its isolated worktree.
    const repoName = opts.repoPath.replace(/\/+$/, '').split('/').pop() ?? 'repository'
    ;({ decomposition, order } = await deps.manager.decompose(
      opts.prompt,
      `a git repository named "${repoName}". Each worker runs inside its own isolated checkout of it (the worker's current working directory); task descriptions must refer to files by repository-relative path only — never absolute paths.`,
    ))
  } catch (err) {
    await deps.tasks.setStatus(root.id, 'failed', { reason: String(err) })
    await deps.events.append({ kind: 'run_completed', taskId: root.id, rootTaskId: root.id, payloadSummary: `failed: ${String(err).slice(0, 160)}` })
    return { rootTaskId: root.id, status: 'failed', taskSummaries: [] }
  }
  const childRows: TaskRow[] = []
  for (const t of decomposition.tasks) {
    const row = await deps.tasks.createChild({
      rootTaskId: root.id,
      parentTaskId: root.id,
      title: t.title,
      description: t.description,
      successCriteria: t.successCriteria,
      createdByAgent: 'manager',
    })
    childRows.push(row)
  }
  for (let i = 0; i < decomposition.tasks.length; i++) {
    for (const dep of decomposition.tasks[i]!.dependsOn) {
      await deps.tasks.addDependency(childRows[i]!.id, childRows[dep]!.id)
    }
  }
  await deps.events.append({
    kind: 'task_decomposed',
    taskId: root.id,
    rootTaskId: root.id,
    agent: 'manager',
    payload: { tasks: decomposition.tasks.map((t) => t.title), order },
    payloadSummary: `${decomposition.tasks.length} tasks`,
  })
  await deps.tasks.setStatus(root.id, 'running')

  // ── Execute the tree sequentially in topological order, chaining worktree
  // baseRefs along dependency edges (plan §4b-2: linear chaining; a task with
  // exactly one dependency branches from that dependency's branch tip).
  const baseRef = opts.baseRef ?? (await defaultBaseRef(opts.repoPath))
  const results: Array<{ id: string; title: string; status: string; resultSummary: string }> = []
  const completedWorkspaces: WorkspaceHandle[] = []
  let lastBranch: string | null = null
  let anyFailed = false

  for (const idx of order) {
    const row = childRows[idx]!
    const spec = decomposition.tasks[idx]!
    if (anyFailed) {
      await deps.tasks.setStatus(row.id, 'cancelled', { reason: 'upstream task failed' })
      results.push({ id: row.id, title: spec.title, status: 'cancelled', resultSummary: 'skipped: upstream failure' })
      continue
    }
    // Sequential lineage (review P1-2): every task branches from the PREVIOUS
    // completed task's branch tip, regardless of declared edges — with
    // sequential execution this guarantees the final branch accumulates ALL
    // completed work (nothing silently dropped from the PR) and that
    // multi-dependency tasks see their dependencies' code. dependsOn still
    // controls ordering and failure cancellation. True per-edge isolation
    // returns with M4a concurrency.
    const taskBaseRef = lastBranch ?? baseRef
    const outcome = await executeTask(deps, opts, row, spec.title, taskBaseRef, log)
    results.push({ id: row.id, title: spec.title, status: outcome.status, resultSummary: outcome.summary })
    if (outcome.status === 'complete' && outcome.branch) {
      lastBranch = outcome.branch
      if (outcome.ws) completedWorkspaces.push(outcome.ws)
    } else {
      anyFailed = true
    }
  }

  // ── Manager synthesis → PR (review F4/F11: synthesis is the Manager's,
  // push + gh pr create are the DISPATCHER's, from the daemon env — the
  // worker env correctly strips publish credentials).
  let prUrl: string | undefined
  const rootStatus: 'complete' | 'failed' = anyFailed ? 'failed' : 'complete'
  if (!anyFailed && lastBranch && opts.openPr !== false) {
    let synth
    try {
      synth = await deps.manager.synthesize({
        prompt: opts.prompt,
        results: results.map((r) => ({ title: r.title, status: r.status, resultSummary: r.resultSummary })),
      })
    } catch (err) {
      // Work is done and committed locally; only the narrative failed (P2-5).
      synth = { prTitle: opts.prompt.slice(0, 80), prBody: `Automated run (synthesis failed: ${String(err).slice(0, 200)}).\n\nTasks:\n${results.map((r) => `- [${r.status}] ${r.title}`).join('\n')}`, usage: { inputTokens: 0, outputTokens: 0 } }
    }
    await deps.events.append({
      kind: 'synthesis',
      taskId: root.id,
      rootTaskId: root.id,
      agent: 'manager',
      payload: synth,
      payloadSummary: synth.prTitle,
    })
    try {
      await execFileAsync('git', ['push', '-u', 'origin', lastBranch], { cwd: opts.repoPath })
      const { stdout } = await execFileAsync(
        'gh',
        ['pr', 'create', '--head', lastBranch, '--title', synth.prTitle, '--body', synth.prBody],
        { cwd: opts.repoPath },
      )
      prUrl = stdout.trim().split('\n').pop()
      await deps.events.append({
        kind: 'pr_opened',
        taskId: root.id,
        rootTaskId: root.id,
        payload: { url: prUrl },
        payloadSummary: prUrl,
      })
    } catch (err) {
      // Failure-registry row (review F11): push / pr create failure is loud.
      await deps.events.append({
        kind: 'pr_failed',
        taskId: root.id,
        rootTaskId: root.id,
        payload: { error: String(err) },
        payloadSummary: `push/PR failed: ${String(err).slice(0, 200)}`,
      })
      await deps.tasks.setStatus(root.id, 'failed', { reason: `push/PR failed: ${String(err)}` })
      // Don't leak the completed workspaces on this early return — preserve
      // them: their branches hold committed work that may not have pushed.
      for (const cws of completedWorkspaces) {
        try { await deps.runtime.teardown(cws, { preserve: true }) } catch { /* reap later */ }
      }
      await deps.events.append({ kind: 'run_completed', taskId: root.id, rootTaskId: root.id, payloadSummary: 'failed' })
      return { rootTaskId: root.id, status: 'failed', prUrl, taskSummaries: results.map((r) => ({ id: r.id, title: r.title, status: r.status, summary: r.resultSummary })) }
    }
  }

  // Deferred teardown of completed workspaces (P1-1): the PR is open (or
  // skipped) — the worktrees and local branches are no longer needed. The
  // pushed remote branch is what the PR rides on.
  for (const cws of completedWorkspaces) {
    try {
      await deps.runtime.teardown(cws)
    } catch (err) {
      log(`[vibe] teardown of completed workspace ${cws.id} failed (reap later): ${String(err)}`)
    }
  }

  await deps.tasks.setStatus(root.id, rootStatus, anyFailed ? { reason: 'one or more tasks failed' } : {})
  await deps.events.append({
    kind: 'run_completed',
    taskId: root.id,
    rootTaskId: root.id,
    payloadSummary: rootStatus,
  })
  return { rootTaskId: root.id, status: rootStatus, prUrl, taskSummaries: results.map((r) => ({ id: r.id, title: r.title, status: r.status, summary: r.resultSummary })) }
}

async function defaultBaseRef(repoPath: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['remote'], { cwd: repoPath })
    if (stdout.split('\n').includes('origin')) return 'origin/main'
  } catch {
    /* fall through */
  }
  return 'main'
}

async function executeTask(
  deps: DispatcherDeps,
  opts: RunOptions,
  row: TaskRow,
  title: string,
  taskBaseRef: string,
  log: (line: string) => void,
): Promise<{ status: 'complete' | 'failed' | 'timed_out'; summary: string; branch?: string; ws?: WorkspaceHandle }> {
  const timeoutMs = opts.taskTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const budgetCents = opts.taskBudgetCents ?? DEFAULT_BUDGET_CENTS
  const caps = deps.worker.capabilities()

  let ws: WorkspaceHandle | null = null
  try {
    ws = await deps.runtime.createWorkspace({
      taskId: row.id,
      baseRepoPath: opts.repoPath,
      baseRef: taskBaseRef,
      attempt: row.attempt_count,
    })
  } catch (err) {
    await deps.tasks.setStatus(row.id, 'failed', { reason: `createWorkspace failed: ${String(err)}`, error: { reason: String(err) } })
    await deps.events.append({
      kind: 'task_status_change',
      taskId: row.id,
      rootTaskId: row.root_task_id,
      payload: { status: 'failed', reason: String(err) },
      payloadSummary: `failed: createWorkspace`,
    })
    return { status: 'failed', summary: `createWorkspace failed: ${String(err)}` }
  }

  // The rendered worker prompt is frozen verbatim into task_spec (#44).
  const description = [
    'You are working in an isolated git worktree of the target repository — it is your current working directory. Refer to all files by RELATIVE path from the CWD. Never use absolute paths and never touch other checkouts of this repository, even if a path appears in the task text.\n\n',
    row.description,
    row.success_criteria ? `\nSuccess criteria: ${row.success_criteria}` : '',
    '\nWhen you are done, stage and commit ALL of your changes in the current working directory with a descriptive message (git add -A && git commit). Do not push.',
  ].join('')
  const spec: TaskSpec = {
    taskId: row.id,
    title,
    description,
    successCriteria: row.success_criteria,
    maxTokens: null,
    timeoutMs,
    workingDirectory: null,
  }
  const apiKey = resolveApiKey(null, deps.env.anthropicApiKey)
  const handle = await deps.worker.start(spec, { env: buildSpawnEnv(apiKey), workspace: ws })
  await deps.tasks.setStatus(row.id, 'running', {
    assignedWorkerType: caps.workerType,
    assignedSessionHandle: handle,
    taskSpec: { ...spec, renderedPrompt: description },
    budgetFidelity: 'low', // ClaudeCodeWorker is the low-fidelity path until #26
  })
  await deps.events.append({
    kind: 'task_dispatched',
    taskId: row.id,
    rootTaskId: row.root_task_id,
    payload: { workspace: ws, sessionHandle: handle },
    payloadSummary: `→ ${caps.workerType} in ${ws.branch}`,
  })
  log(`[vibe] task ${title}: dispatched to ${caps.workerType} (${ws.branch})`)

  // Event loop shape per review F19: race stream consumption against the
  // wall-clock deadline AND the ADR-0001 zombie rule (no event for 3×
  // heartbeat interval → stop, reason zombie).
  let terminal: Extract<WorkerEvent, { kind: 'complete' | 'failed' }> | null = null
  let sawTerminal = false
  let lastEventAt = Date.now()
  let stopReason: 'timeout' | 'zombie' | null = null

  let streamEnded = false
  const consume = (async () => {
    for await (const ev of deps.worker.stream(handle)) {
      if (sawTerminal) {
        // Ignore-after-terminal (review S4): contract violation, warn + drop.
        log(`[vibe] task ${title}: event after terminal ignored (${ev.kind})`)
        continue
      }
      lastEventAt = Date.now()
      await deps.events.append({
        kind: `worker_event:${ev.kind}`,
        taskId: row.id,
        rootTaskId: row.root_task_id,
        agent: `worker:${handle}`,
        payload: ev,
        payloadSummary: ev.kind === 'failed' ? ev.reason.slice(0, 200) : undefined,
      })
      // Router, trigger 2: mid-run blocked events (wired; DORMANT until #26 —
      // whole-stdout parsing cannot emit blocked mid-run by construction).
      if (ev.kind === 'blocked') {
        const routed = await deps.vision.classify({
          trigger: 'worker_blocked',
          taskTitle: title,
          reason: ev.reason,
          needs: ev.needs,
        })
        await deps.events.append({
          kind: 'router_decision',
          taskId: row.id,
          rootTaskId: row.root_task_id,
          agent: 'vision',
          payload: { trigger: 'worker_blocked', input: routed.rubricInput, decision: routed.decision, usage: routed.usage },
          payloadSummary: `${routed.decision.escalate ? 'ESCALATE' : 'proceed'}: ${routed.decision.reason}`,
        })
        if (routed.decision.escalate) {
          await raiseEscalation({
            events: deps.events,
            rootTaskId: row.root_task_id,
            taskId: row.id,
            decision: routed.decision,
            context: `Task "${title}" blocked: ${ev.reason} (needs: ${ev.needs})`,
            webhookUrl: deps.env.slackWebhookUrl,
          })
        }
      }
      if (ev.kind === 'complete' || ev.kind === 'failed') {
        terminal = ev
        sawTerminal = true
      }
    }
    streamEnded = true
  })()

  // Watchdog: wall-clock timeout + zombie detection, polled coarsely.
  const watchdog = (async () => {
    const deadline = Date.now() + timeoutMs
    // streamEnded without a terminal is the crash case — the synthetic-failed
    // path below handles it; the watchdog must not keep the run alive 3x
    // heartbeat waiting for events that can never come.
    while (!sawTerminal && !streamEnded) {
      await new Promise((r) => setTimeout(r, 1000))
      if (sawTerminal || streamEnded) return
      if (Date.now() > deadline) {
        stopReason = 'timeout'
        await deps.worker.stop(handle, 'timeoutMs exceeded')
        return
      }
      // ADR-0001's zombie rule is about worker EMISSION, not dispatcher
      // consumption — status().lastEventAt is the channel the ADR provides
      // (a slow DB write must not zombie a healthy worker, review P3-11).
      const st = await deps.worker.status(handle).catch(() => null)
      const emittedAt = st?.lastEventAt ?? lastEventAt
      if (Date.now() - Math.max(emittedAt, lastEventAt) > HEARTBEAT_INTERVAL_MS * 3) {
        stopReason = 'zombie'
        await deps.worker.stop(handle, 'zombie: no events for 3x heartbeat interval')
        return
      }
    }
  })()

  try {
    await consume
  } catch (err) {
    // Persistence (or router) failure mid-stream (P2-4): the detached worker
    // must not keep spending unsupervised. Stop it, mark the task failed
    // loudly, preserve the workspace, and end the stream.
    sawTerminal = true // stops the watchdog
    try { await deps.worker.stop(handle, `orchestrator error: ${String(err)}`) } catch { /* best effort */ }
    try { await deps.tasks.setStatus(row.id, 'failed', { reason: `orchestrator_error: ${String(err)}` }) } catch { /* db may be the failure */ }
    try { await deps.runtime.teardown(ws, { preserve: true }) } catch { /* reap later */ }
    await watchdog.catch(() => {})
    return { status: 'failed', summary: `orchestrator_error: ${String(err)}` }
  }
  // Watchdog exits promptly once sawTerminal flips (1s poll).
  await watchdog

  // ADR-0001 contract: stream closed without terminal → synthetic failed.
  if (!terminal) {
    terminal = {
      kind: 'failed',
      at: Date.now(),
      reason: 'stream_closed_without_terminal',
      recoverable: false,
    }
    await deps.events.append({
      kind: 'worker_event:failed',
      taskId: row.id,
      rootTaskId: row.root_task_id,
      agent: 'orchestrator',
      payload: terminal,
      payloadSummary: 'synthetic: stream_closed_without_terminal',
    })
  }
  // TS can't see the assignments inside the consume closure; widen explicitly.
  const term = terminal as Extract<WorkerEvent, { kind: 'complete' | 'failed' }>

  // Budget floor: spend derived idempotently from the persisted events.
  const spentCents = await deps.events.spentCentsFor(
    row.id,
    caps.costPerMillionInputTokens,
    caps.costPerMillionOutputTokens,
  )
  await deps.tasks.recomputeSpend(row.id, spentCents)
  const budgetExceeded = spentCents > budgetCents

  // Map outcome to the task state machine per ADR-0001's error-semantics
  // table: dispatcher-initiated stops rewrite the worker's terminal.
  // A "complete" coding task that committed NOTHING is a failure, not a
  // success — the smoke run's first attempt had workers complete cleanly
  // while writing zero files, and the empty branches only failed later at
  // gh pr create, far from the cause. Validate structurally here.
  let committedNothing = false
  if (term.kind === 'complete' && stopReason === null) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['rev-list', '--count', 'HEAD', `^${taskBaseRef}`],
        { cwd: ws.path },
      )
      committedNothing = Number(stdout.trim()) === 0
    } catch {
      // Unmanaged/odd workspace — skip the guard rather than false-fail.
    }
  }

  let finalStatus: 'complete' | 'failed' | 'timed_out'
  let reason: string | null = null
  if (stopReason === 'timeout') {
    finalStatus = 'timed_out'
    reason = `timeoutMs (${timeoutMs}) exceeded`
  } else if (stopReason === 'zombie') {
    finalStatus = 'failed'
    reason = 'zombie'
  } else if (budgetExceeded) {
    finalStatus = 'failed'
    reason = `budget_exceeded: spent ${spentCents.toFixed(4)}¢ > cap ${budgetCents}¢ (low-fidelity post-hoc check; mid-run enforcement is #26)`
  } else if (term.kind === 'complete' && committedNothing) {
    finalStatus = 'failed'
    reason = 'no_changes_committed: worker reported complete but its branch has zero commits over its base'
  } else if (term.kind === 'complete') {
    finalStatus = 'complete'
  } else {
    finalStatus = 'failed'
    reason = term.reason
  }

  await deps.tasks.setStatus(row.id, finalStatus, {
    reason,
    result: term.kind === 'complete' ? term.result : undefined,
    error: term.kind === 'failed' ? { reason: term.reason, recoverable: term.recoverable, terminationMode: term.terminationMode } : undefined,
  })
  await deps.events.append({
    kind: 'task_status_change',
    taskId: row.id,
    rootTaskId: row.root_task_id,
    payload: { status: finalStatus, reason },
    payloadSummary: `${finalStatus}${reason ? `: ${reason.slice(0, 160)}` : ''}`,
  })

  // Teardown policy (review A14 + P1-1): failed/timed_out are preserved for
  // post-mortem NOW; completed workspaces are NOT torn down here — teardown
  // deletes the branch, which the next task's baseRef and the final push
  // still need. runRoot tears completed workspaces down after the PR step.
  if (finalStatus !== 'complete') {
    try {
      await deps.runtime.teardown(ws, { preserve: true })
    } catch (err) {
      log(`[vibe] task ${title}: teardown failed (workspace left for reap): ${String(err)}`)
    }
  }

  log(`[vibe] task ${title}: ${finalStatus}${reason ? ` (${reason.slice(0, 120)})` : ''} — ${spentCents.toFixed(4)}¢`)
  // Summary follows the FINAL status, not the worker's terminal: a complete
  // envelope on a budget-exceeded/timed-out task must not read as success.
  const summary =
    finalStatus === 'complete' && term.kind === 'complete'
      ? typeof (term.result as { result?: unknown })?.result === 'string'
        ? ((term.result as { result: string }).result.slice(0, 500))
        : 'completed'
      : reason ?? 'failed'
  return finalStatus === 'complete'
    ? { status: 'complete', summary, branch: ws.branch, ws }
    : { status: finalStatus, summary }
}
