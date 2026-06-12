import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { runRoot, type DispatcherDeps } from '../../src/orchestrator/dispatcher.ts'
import type { TaskRow } from '../../src/persistence/repos.ts'
import type { TaskStatus } from '../../src/persistence/statuses.ts'
import type { WorkerAgent, WorkerEvent } from '../../src/workers/types.ts'
import type { WorkerRuntime, WorkspaceHandle } from '../../src/runtime/types.ts'
import type { Decomposition } from '../../src/agents/manager-agent.ts'

// ── In-memory fakes ─────────────────────────────────────────────────────────

function makeFakes() {
  const rows = new Map<string, TaskRow>()
  const deps: Array<{ taskId: string; dependsOn: string }> = []
  const events: Array<{ kind: string; taskId: string | null; payload: unknown; summary?: string }> = []
  const tokensByTask = new Map<string, Array<{ inputTokens: number; outputTokens: number }>>()

  const mkRow = (over: Partial<TaskRow>): TaskRow => ({
    id: randomUUID(),
    parent_task_id: null,
    root_task_id: '',
    title: '',
    description: '',
    success_criteria: null,
    status: 'pending' as TaskStatus,
    status_reason: null,
    created_by_agent: 'human',
    assigned_worker_type: null,
    assigned_session_handle: null,
    task_spec: null,
    result: null,
    error: null,
    budget_fidelity: 'high',
    token_budget_cents: null,
    tokens_spent_cents: '0',
    idempotency_key: null,
    attempt_count: 0,
    ...over,
  })

  const tasks: DispatcherDeps['tasks'] = {
    async createRoot(input) {
      const row = mkRow({ title: input.title, description: input.description })
      row.root_task_id = row.id
      rows.set(row.id, row)
      return row
    },
    async createChild(input) {
      const row = mkRow({
        root_task_id: input.rootTaskId,
        parent_task_id: input.parentTaskId,
        title: input.title,
        description: input.description,
        success_criteria: input.successCriteria,
        created_by_agent: input.createdByAgent,
      })
      rows.set(row.id, row)
      return row
    },
    async addDependency(taskId, dependsOn) {
      deps.push({ taskId, dependsOn })
    },
    async setStatus(taskId, status, fields = {}) {
      const row = rows.get(taskId)!
      row.status = status
      if (fields.reason !== undefined && fields.reason !== null) row.status_reason = fields.reason
    },
    async recomputeSpend(taskId, cents) {
      rows.get(taskId)!.tokens_spent_cents = String(cents)
    },
    async get(taskId) {
      return rows.get(taskId) ?? null
    },
  }

  const eventsPort: DispatcherDeps['events'] = {
    async append(input) {
      events.push({ kind: input.kind, taskId: input.taskId ?? null, payload: input.payload, summary: input.payloadSummary })
      if (input.kind === 'worker_event:tokens' && input.taskId) {
        const p = input.payload as { inputTokens: number; outputTokens: number }
        const arr = tokensByTask.get(input.taskId) ?? []
        arr.push(p)
        tokensByTask.set(input.taskId, arr)
      }
    },
    async spentCentsFor(taskId, inCents, outCents) {
      let cents = 0
      for (const t of tokensByTask.get(taskId) ?? []) {
        cents += (t.inputTokens / 1e6) * inCents + (t.outputTokens / 1e6) * outCents
      }
      return cents
    },
  }

  const created: WorkspaceHandle[] = []
  const tornDown: Array<{ id: string; preserve: boolean }> = []
  const baseRefs: string[] = []
  const runtime: WorkerRuntime = {
    async createWorkspace(spec) {
      baseRefs.push(spec.baseRef)
      const ws = { id: `${spec.taskId}-a${spec.attempt}`, path: `/fake/${spec.taskId}`, branch: `vibe/${spec.taskId}-a${spec.attempt}` }
      created.push(ws)
      return ws
    },
    async exec() {
      throw new Error('not used — fake worker does not exec')
    },
    async teardown(ws, opts) {
      tornDown.push({ id: ws.id, preserve: opts?.preserve === true })
    },
    async listWorkspaces() {
      return created
    },
  }

  return { rows, deps, events, runtime, tasks, eventsPort, tornDown, baseRefs }
}

// Scripted worker: each start() consumes the next script entry.
function fakeWorker(scripts: Array<WorkerEvent[] | 'never-terminal'>): WorkerAgent {
  let n = 0
  const sessions = new Map<string, WorkerEvent[] | 'never-terminal'>()
  const stopped = new Set<string>()
  return {
    capabilities: () => ({
      workerType: 'fake',
      modelId: 'fake-model',
      maxContextTokens: 1,
      costPerMillionInputTokens: 1500,
      costPerMillionOutputTokens: 7500,
      supportsStreaming: false,
      supportsToolUse: false,
      declaredLanguages: null,
      protocolVersion: 1,
    }),
    async start() {
      const handle = `fake:${n}`
      sessions.set(handle, scripts[Math.min(n, scripts.length - 1)]!)
      n++
      return handle
    },
    async status() {
      return { state: 'running', reason: null, lastEventAt: Date.now() }
    },
    async *stream(handle) {
      const script = sessions.get(handle)!
      if (script === 'never-terminal') {
        // Emit nothing terminal; wait until stop() flips us, then end the
        // stream WITHOUT a terminal event (models a killed subprocess).
        while (!stopped.has(handle)) await new Promise((r) => setTimeout(r, 20))
        return
      }
      for (const ev of script) yield ev
    },
    async stop(handle) {
      stopped.add(handle)
    },
  }
}

const proceed = { decision: { escalate: false, reason: 'routine', urgency: 'low' as const }, rubricInput: 'x', usage: { inputTokens: 1, outputTokens: 1 } }
const twoTaskChain: Decomposition = {
  tasks: [
    { title: 'task A', description: 'do A', successCriteria: null, dependsOn: [] },
    { title: 'task B', description: 'do B', successCriteria: null, dependsOn: [0] },
  ],
}

function makeDeps(f: ReturnType<typeof makeFakes>, worker: WorkerAgent, decomposition: Decomposition = twoTaskChain, escalateInbound = false): DispatcherDeps {
  return {
    runtime: f.runtime,
    worker,
    tasks: f.tasks,
    events: f.eventsPort,
    vision: {
      async classify(input) {
        if (input.trigger === 'inbound_prompt' && escalateInbound) {
          return { ...proceed, decision: { escalate: true, reason: 'touches auth', urgency: 'high' as const } }
        }
        return proceed
      },
    },
    manager: {
      async decompose() {
        return { decomposition, order: decomposition.tasks.map((_, i) => i), usage: { inputTokens: 1, outputTokens: 1 } }
      },
      async synthesize() {
        return { prTitle: 'synth title', prBody: 'synth body', usage: { inputTokens: 1, outputTokens: 1 } }
      },
    },
    env: { anthropicApiKey: 'sk-ant-fake' },
    log: () => {},
  }
}

const completeScript = (tokens = { inputTokens: 1000, outputTokens: 500 }): WorkerEvent[] => [
  { kind: 'tokens', at: Date.now(), ...tokens },
  { kind: 'complete', at: Date.now(), partial: false, result: { is_error: false, result: 'done' } },
]

describe('dispatcher — runRoot', () => {
  it('happy path: ≥2 tasks execute dependency-ordered with baseRef chaining; PR skipped with --no-pr', async () => {
    const f = makeFakes()
    const deps = makeDeps(f, fakeWorker([completeScript(), completeScript()]))
    const out = await runRoot(deps, { prompt: 'build it', repoPath: '/fake/repo', baseRef: 'origin/main', openPr: false })
    assert.equal(out.status, 'complete')
    assert.equal(out.taskSummaries.length, 2)
    assert.ok(out.taskSummaries.every((t) => t.status === 'complete'))
    // baseRef chaining (§4b-2): task B branches from task A's branch tip.
    assert.equal(f.baseRefs[0], 'origin/main')
    assert.match(f.baseRefs[1]!, /^vibe\//)
    // Events spine: router decision, decomposition, dispatches, worker events, run end.
    const kinds = f.events.map((e) => e.kind)
    assert.ok(kinds.includes('router_decision'))
    assert.ok(kinds.includes('task_decomposed'))
    assert.equal(kinds.filter((k) => k === 'task_dispatched').length, 2)
    assert.ok(kinds.includes('worker_event:tokens'))
    assert.ok(kinds.includes('run_completed'))
    // Teardown: complete tasks are removed, not preserved.
    assert.deepEqual(f.tornDown.map((t) => t.preserve), [false, false])
  })

  it('inbound escalation blocks the run before any dispatch (router trigger 1)', async () => {
    const f = makeFakes()
    const deps = makeDeps(f, fakeWorker([completeScript()]), twoTaskChain, true)
    const out = await runRoot(deps, { prompt: 'rotate the auth keys', repoPath: '/fake', openPr: false })
    assert.equal(out.status, 'blocked')
    const kinds = f.events.map((e) => e.kind)
    assert.ok(kinds.includes('escalation_raised'))
    assert.ok(!kinds.includes('task_dispatched'), 'nothing may be dispatched after an inbound escalation')
  })

  it('failed task: downstream cancelled, workspace preserved, root failed', async () => {
    const f = makeFakes()
    const failScript: WorkerEvent[] = [
      { kind: 'failed', at: Date.now(), reason: 'rate limited', recoverable: false },
    ]
    const deps = makeDeps(f, fakeWorker([failScript, completeScript()]))
    const out = await runRoot(deps, { prompt: 'x', repoPath: '/fake', openPr: false })
    assert.equal(out.status, 'failed')
    assert.deepEqual(out.taskSummaries.map((t) => t.status), ['failed', 'cancelled'])
    // Preserve-on-failure (review A14).
    assert.deepEqual(f.tornDown.map((t) => t.preserve), [true])
  })

  it('stream closes without terminal → synthetic failed (ADR-0001 contract)', async () => {
    const f = makeFakes()
    const deps = makeDeps(f, fakeWorker([[]])) // empty stream: ends with no terminal
    const out = await runRoot(deps, { prompt: 'x', repoPath: '/fake', openPr: false })
    assert.equal(out.status, 'failed')
    const synthetic = f.events.find((e) => e.summary?.includes('stream_closed_without_terminal'))
    assert.ok(synthetic, 'synthetic failed event must be recorded')
  })

  it('budget floor: post-hoc token check fails the task with budget_exceeded (review F8)', async () => {
    const f = makeFakes()
    // 10M output tokens at 7500¢/M = 75000¢ ≫ 1¢ cap.
    const deps = makeDeps(f, fakeWorker([completeScript({ inputTokens: 0, outputTokens: 10_000_000 })]))
    const out = await runRoot(deps, { prompt: 'x', repoPath: '/fake', openPr: false, taskBudgetCents: 1 })
    assert.equal(out.status, 'failed')
    assert.match(out.taskSummaries[0]!.summary, /budget_exceeded/)
  })

  it('wall-clock timeout: worker stopped, task timed_out (review F19 state rewrite)', async () => {
    const f = makeFakes()
    const oneTask: Decomposition = { tasks: [{ title: 'slow', description: 'slow', successCriteria: null, dependsOn: [] }] }
    const deps = makeDeps(f, fakeWorker(['never-terminal']), oneTask)
    const out = await runRoot(deps, { prompt: 'x', repoPath: '/fake', openPr: false, taskTimeoutMs: 1200 })
    assert.equal(out.status, 'failed')
    assert.equal(out.taskSummaries[0]!.status, 'timed_out')
  })
})
