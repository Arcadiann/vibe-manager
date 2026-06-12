import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { TASK_STATUSES } from '../../src/persistence/statuses.ts'

// #38: automated status-vocabulary drift detection. Three artifacts must
// agree; this test needs no database — the migration SQL file is the
// authoritative source of the CHECK constraint.

describe('status vocabulary drift (#38)', () => {
  it('TASK_STATUSES matches the migration CHECK constraint exactly', async () => {
    const sql = await readFile(
      join(import.meta.dirname, '..', '..', 'supabase', 'migrations', '0001_vibe_manager_init.sql'),
      'utf8',
    )
    const m = /check \(status in \(([^)]+)\)\)/.exec(sql)
    assert.ok(m, 'migration must contain the tasks.status CHECK constraint')
    const sqlStatuses = m[1]!
      .split(',')
      .map((s) => s.trim().replace(/'/g, ''))
      .sort()
    assert.deepEqual(sqlStatuses, [...TASK_STATUSES].sort(), 'statuses.ts and migration SQL drifted')
  })

  it('TASK_STATUSES matches ADR-0001 worker states modulo the documented deltas', () => {
    // ADR-0001 WorkerStatusReport.state (from src/workers/types.ts).
    // Documented deltas (ADR-0003 §status vocabulary): worker 'starting'
    // collapses into task 'running'; task-only 'pending' is the orchestrator
    // extension. Anything else differing is drift.
    const workerStates = ['starting', 'running', 'blocked', 'complete', 'failed', 'timed_out', 'cancelled']
    const expected = new Set(workerStates.filter((s) => s !== 'starting'))
    expected.add('pending')
    assert.deepEqual(new Set(TASK_STATUSES), expected, 'task statuses drifted from ADR-0001 worker states')
  })
})
