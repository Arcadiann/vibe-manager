import { randomUUID } from 'node:crypto'
import type pg from 'pg'

import { withRetry } from './db.ts'
import { TASK_STATUSES, type TaskStatus } from './statuses.ts'

export type TaskRow = {
  id: string
  parent_task_id: string | null
  root_task_id: string
  title: string
  description: string
  success_criteria: string | null
  status: TaskStatus
  status_reason: string | null
  created_by_agent: string
  assigned_worker_type: string | null
  assigned_session_handle: string | null
  task_spec: unknown
  result: unknown
  error: unknown
  budget_fidelity: 'high' | 'low'
  token_budget_cents: string | null
  tokens_spent_cents: string
  idempotency_key: string | null
  attempt_count: number
}

export class TasksRepo {
  readonly #pool: pg.Pool
  constructor(pool: pg.Pool) {
    this.#pool = pool
  }

  async createRoot(input: {
    title: string
    description: string
    idempotencyKey?: string
  }): Promise<TaskRow> {
    const id = randomUUID()
    return withRetry('tasks.createRoot', async () => {
      // on conflict DO NOTHING covers BOTH the idempotency_key dedup (#42)
      // and a retried ambiguous write re-inserting our client-minted id
      // (review P3-9) — either conflict falls through to the lookups below.
      const r = await this.#pool.query(
        `insert into vibe_manager.tasks (id, root_task_id, title, description, created_by_agent, idempotency_key)
         values ($1, $1, $2, $3, 'human', $4)
         on conflict do nothing
         returning *`,
        [id, input.title, input.description, input.idempotencyKey ?? null],
      )
      if (r.rows[0]) return r.rows[0] as TaskRow
      const byId = await this.#pool.query(`select * from vibe_manager.tasks where id = $1`, [id])
      if (byId.rows[0]) return byId.rows[0] as TaskRow
      const existing = await this.#pool.query(
        `select * from vibe_manager.tasks where idempotency_key = $1`,
        [input.idempotencyKey],
      )
      return existing.rows[0] as TaskRow
    })
  }

  async createChild(input: {
    rootTaskId: string
    parentTaskId: string
    title: string
    description: string
    successCriteria: string | null
    createdByAgent: string
  }): Promise<TaskRow> {
    return withRetry('tasks.createChild', async () => {
      const r = await this.#pool.query(
        `insert into vibe_manager.tasks (root_task_id, parent_task_id, title, description, success_criteria, created_by_agent)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [input.rootTaskId, input.parentTaskId, input.title, input.description, input.successCriteria, input.createdByAgent],
      )
      return r.rows[0] as TaskRow
    })
  }

  async addDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    await withRetry('tasks.addDependency', () =>
      this.#pool.query(
        `insert into vibe_manager.task_dependencies (task_id, depends_on_task_id) values ($1, $2)`,
        [taskId, dependsOnTaskId],
      ),
    )
  }

  async setStatus(
    taskId: string,
    status: TaskStatus,
    fields: {
      reason?: string | null
      result?: unknown
      error?: unknown
      assignedWorkerType?: string
      assignedSessionHandle?: string
      taskSpec?: unknown
      budgetFidelity?: 'high' | 'low'
      attemptCount?: number
    } = {},
  ): Promise<void> {
    if (!TASK_STATUSES.includes(status)) throw new Error(`invalid status: ${status}`)
    await withRetry('tasks.setStatus', () =>
      this.#pool.query(
        `update vibe_manager.tasks set
           status = $2,
           status_reason = coalesce($3, status_reason),
           result = coalesce($4::jsonb, result),
           error = coalesce($5::jsonb, error),
           assigned_worker_type = coalesce($6, assigned_worker_type),
           assigned_session_handle = coalesce($7, assigned_session_handle),
           task_spec = coalesce($8::jsonb, task_spec),
           budget_fidelity = coalesce($9, budget_fidelity),
           attempt_count = coalesce($10, attempt_count),
           started_at = case when $2 = 'running' and started_at is null then now() else started_at end,
           completed_at = case when $2 in ('complete','failed','timed_out','cancelled') then now() else completed_at end
         where id = $1`,
        [
          taskId,
          status,
          fields.reason ?? null,
          fields.result === undefined ? null : JSON.stringify(fields.result),
          fields.error === undefined ? null : JSON.stringify(fields.error),
          fields.assignedWorkerType ?? null,
          fields.assignedSessionHandle ?? null,
          fields.taskSpec === undefined ? null : JSON.stringify(fields.taskSpec),
          fields.budgetFidelity ?? null,
          fields.attemptCount ?? null,
        ],
      ),
    )
  }

  // Derived idempotently from a fresh read of events, never a blind increment
  // (§4b-9: a retried ambiguous write must not double-count spend).
  async recomputeSpend(taskId: string, centsFromEvents: number): Promise<void> {
    await withRetry('tasks.recomputeSpend', () =>
      this.#pool.query(`update vibe_manager.tasks set tokens_spent_cents = $2 where id = $1`, [
        taskId,
        centsFromEvents.toFixed(8),
      ]),
    )
  }

  async subtree(rootTaskId: string): Promise<TaskRow[]> {
    const r = await this.#pool.query(
      `select * from vibe_manager.tasks where root_task_id = $1 order by created_at`,
      [rootTaskId],
    )
    return r.rows as TaskRow[]
  }

  async recentRoots(limit = 10): Promise<TaskRow[]> {
    const r = await this.#pool.query(
      `select * from vibe_manager.tasks where id = root_task_id order by created_at desc limit $1`,
      [limit],
    )
    return r.rows as TaskRow[]
  }

  async get(taskId: string): Promise<TaskRow | null> {
    const r = await this.#pool.query(`select * from vibe_manager.tasks where id = $1`, [taskId])
    return (r.rows[0] as TaskRow) ?? null
  }
}

export class EventsRepo {
  readonly #pool: pg.Pool
  constructor(pool: pg.Pool) {
    this.#pool = pool
  }

  // dedupe_key + ON CONFLICT DO NOTHING: a retry after an ambiguous WAN
  // timeout cannot duplicate the audit log (§4b-9).
  async append(input: {
    kind: string
    taskId?: string | null
    rootTaskId?: string | null
    agent?: string
    payload?: unknown
    payloadSummary?: string
  }): Promise<void> {
    const dedupeKey = randomUUID()
    await withRetry(`events.append(${input.kind})`, () =>
      this.#pool.query(
        `insert into vibe_manager.events (kind, task_id, root_task_id, agent, payload, payload_summary, dedupe_key)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7)
         on conflict (dedupe_key) do nothing`,
        [
          input.kind,
          input.taskId ?? null,
          input.rootTaskId ?? null,
          input.agent ?? 'orchestrator',
          JSON.stringify(input.payload ?? {}),
          input.payloadSummary ?? null,
          dedupeKey,
        ],
      ),
    )
  }

  async forRoot(rootTaskId: string): Promise<Array<{ ts: Date; kind: string; agent: string | null; payload_summary: string | null; payload: unknown }>> {
    const r = await this.#pool.query(
      `select ts, kind, agent, payload_summary, payload from vibe_manager.events
       where root_task_id = $1 order by id`,
      [rootTaskId],
    )
    return r.rows
  }

  async spentCentsFor(taskId: string, costPerMInputCents: number, costPerMOutputCents: number): Promise<number> {
    const r = await this.#pool.query(
      `select payload from vibe_manager.events where task_id = $1 and kind = 'worker_event:tokens'`,
      [taskId],
    )
    let cents = 0
    for (const row of r.rows) {
      const p = row.payload as { inputTokens?: number; outputTokens?: number }
      cents +=
        ((p.inputTokens ?? 0) / 1_000_000) * costPerMInputCents +
        ((p.outputTokens ?? 0) / 1_000_000) * costPerMOutputCents
    }
    return cents
  }
}
