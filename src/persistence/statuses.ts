// Single source of truth for the task state machine (#38).
//
// ADR-0003 §status vocabulary: tasks.status = ADR-0001's WorkerStatusReport
// states, minus 'starting' (collapsed into 'running' at the task level), plus
// the orchestrator-only 'pending'. Three artifacts must stay in sync:
//   1. this const (what the orchestrator writes),
//   2. the CHECK constraint in supabase/migrations/0001_vibe_manager_init.sql,
//   3. ADR-0001's WorkerStatusReport.state union.
// tests/persistence/status-drift.test.ts asserts 1↔2 (parsing the SQL, no DB
// needed) and 1↔3 (via the worker types).

export const TASK_STATUSES = [
  'pending',
  'running',
  'blocked',
  'complete',
  'failed',
  'timed_out',
  'cancelled',
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'complete',
  'failed',
  'timed_out',
  'cancelled',
])
