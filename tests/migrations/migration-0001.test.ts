import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// Migration behavior tests (plan §4b-4): the append-only trio — UPDATE
// blocked, raw DELETE blocked, GUC-gated prune succeeds — plus dedupe_key
// idempotency. DESTRUCTIVE (applies down+up): requires an explicitly
// disposable database, never the production Supabase project.
const DB_URL = process.env.VIBE_TEST_DATABASE_URL
const SKIP = !DB_URL
  ? 'set VIBE_TEST_DATABASE_URL to a DISPOSABLE database to run migration tests (down+up is destructive)'
  : false

describe('migration 0001 — vibe_manager schema', { skip: SKIP }, () => {
  // pg is imported lazily so the suite loads without node_modules access in
  // environments that only run the unit tests.
  let client: import('pg').Client

  before(async () => {
    const { Client } = await import('pg')
    client = new Client({ connectionString: DB_URL })
    await client.connect()
    const root = join(import.meta.dirname, '..', '..')
    const down = await readFile(join(root, 'supabase', 'migrations', '0001_vibe_manager_init_down.sql'), 'utf8')
    const up = await readFile(join(root, 'supabase', 'migrations', '0001_vibe_manager_init.sql'), 'utf8')
    await client.query(down)
    await client.query(up)
  })

  after(async () => {
    await client?.end()
  })

  async function insertEvent(kind: string): Promise<number> {
    const r = await client.query(
      `insert into vibe_manager.events (kind, payload) values ($1, '{}') returning id`,
      [kind],
    )
    return r.rows[0].id
  }

  it('append-only trio 1/3: UPDATE on events raises', async () => {
    const id = await insertEvent('test_update_block')
    await assert.rejects(
      () => client.query(`update vibe_manager.events set kind = 'tampered' where id = $1`, [id]),
      /append-only/,
    )
  })

  it('append-only trio 2/3: raw DELETE on events raises', async () => {
    const id = await insertEvent('test_delete_block')
    await assert.rejects(
      () => client.query(`delete from vibe_manager.events where id = $1`, [id]),
      /append-only/,
    )
  })

  it('append-only trio 3/3: prune_events() is the sanctioned delete path', async () => {
    await insertEvent('test_prunable')
    // retention '0 seconds' prunes everything inserted so far.
    const r = await client.query(`select vibe_manager.prune_events(interval '0 seconds') as n`)
    assert.ok(Number(r.rows[0].n) >= 1, 'prune must delete rows without tripping the trigger')
    // And the GUC carve-out was transaction-local: a raw delete still raises.
    const id = await insertEvent('test_still_blocked')
    await assert.rejects(
      () => client.query(`delete from vibe_manager.events where id = $1`, [id]),
      /append-only/,
    )
  })

  it('dedupe_key: retried ambiguous write cannot duplicate the audit log (§4b-9)', async () => {
    const key = '7f1e2d3c-0000-4000-8000-000000000001'
    const insert = `insert into vibe_manager.events (kind, payload, dedupe_key)
                    values ('test_dedupe', '{}', $1) on conflict (dedupe_key) do nothing`
    await client.query(insert, [key])
    await client.query(insert, [key]) // the "retry"
    const r = await client.query(
      `select count(*)::int as n from vibe_manager.events where dedupe_key = $1`,
      [key],
    )
    assert.equal(r.rows[0].n, 1)
  })

  it('tasks: status CHECK enforces the unified vocabulary; idempotency_key is UNIQUE', async () => {
    // Roots are self-referential (id = root_task_id in one insert).
    const idRes = await client.query(`select gen_random_uuid() as id`)
    const rootId: string = idRes.rows[0].id
    await client.query(
      `insert into vibe_manager.tasks (id, root_task_id, title, description, created_by_agent)
       values ($1, $1, 'root', 'root', 'human')`,
      [rootId],
    )
    const mk = (status: string, key: string | null) =>
      client.query(
        `insert into vibe_manager.tasks (root_task_id, title, description, status, created_by_agent, idempotency_key)
         values ($1, 't', 'd', $2, 'human', $3)`,
        [rootId, status, key],
      )
    await assert.rejects(() => mk('exploded', null), /check/i)
    await mk('pending', 'dup-key')
    await assert.rejects(() => mk('pending', 'dup-key'), /unique|duplicate/i)
  })

  it('memory: halfvec(3072) column accepts a 3072-dim embedding', async () => {
    const vec = `[${Array.from({ length: 3072 }, () => 0).join(',')}]`
    await client.query(
      `insert into vibe_manager.memory (content, embedding, kind, tier, created_by_agent, source)
       values ('test', $1, 'fact', 'system', 'system', 'external')`,
      [vec],
    )
    const r = await client.query(`select count(*)::int as n from vibe_manager.memory`)
    assert.ok(r.rows[0].n >= 1)
  })
})
