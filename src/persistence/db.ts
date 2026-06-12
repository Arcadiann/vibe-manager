import pg from 'pg'

// Postgres client discipline per plan §4b-3 / ADR-0003 amendment:
// - SESSION-mode / direct connection (port 5432) is mandatory. Supavisor
//   transaction pooling (6543) breaks session state and LISTEN/NOTIFY, and
//   silently defeats anything session-scoped. vibe doctor checks the port.
// - The pool installs an error handler: Supabase maintenance restarts emit
//   idle-client errors that would otherwise CRASH the daemon — which, with
//   detached workers, means unsupervised spend until human return.
export function createPool(connectionString: string): pg.Pool {
  // Supabase connections must be TLS. Their poolers present certs from
  // Supabase's own CA, which Node's default trust store rejects — encrypt
  // without chain verification for v1 (single operator, known host; full CA
  // pinning is cheap to add when the cert is downloaded from the dashboard).
  const isSupabase = /supabase\.(co|com)/.test(connectionString)
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    keepAlive: true,
    options: '-c search_path=vibe_manager,public,extensions',
    ...(isSupabase ? { ssl: { rejectUnauthorized: false } } : {}),
  })
  pool.on('error', (err) => {
    // Idle client dropped (server restart, WAN blip). Loud, never fatal —
    // the next query checks out a fresh client and reconnects.
    console.error(`[vibe] pg pool idle-client error (recovering): ${err.message}`)
  })
  return pool
}

// Bounded retry for WRITES per the amendment: 3 attempts with backoff, then
// fail the surrounding task loudly. Never limp silently past persistence
// errors; never retry forever (the dedupe_key makes retried event INSERTs
// idempotent, so a retry after an ambiguous timeout is safe).
export async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      console.error(`[vibe] db write failed (${label}, attempt ${attempt}/3): ${String(err)}`)
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)))
    }
  }
  throw new Error(`db write failed after 3 attempts (${label}): ${String(lastErr)}`)
}
