# ADR-0003: Persistence Schema — `tasks`, `task_dependencies`, `memory`, `events`

- Status: Proposed (operator review pending; amended 2026-06-11 — see §Amendments. Gates #33, #41–#47 resolved or migration-bound below; #34/#36/#37 remain parked, so the ADR stays Proposed.)
- Date: 2026-05-17
- Supersedes: —

## Context

Vibe Manager needs first-class persistence for three concerns the architecture has already identified ([`docs/vision.md`](../vision.md) "Architecture sketch"): work-in-flight (tasks with parent/child hierarchy, dependencies, and a state machine), semantic memory shared across agents (vector-searchable via pgvector), and an append-only audit log (every event the orchestrator and workers emit, sufficient to reconstruct "why did this happen at 2am"). [`docs/vision.md` open question #1](../vision.md) names "concrete Postgres schema for `tasks`, `memory`, `events` tables" as a planning-stage decision; this ADR resolves it.

The worker tier is already shipping events that need a destination. [ADR-0001](0001-worker-agent-interface.md) defines the `WorkerEvent` taxonomy (10 variants) and the worker state machine; [ADR-0002](0002-worker-auth-api-key.md) locks worker auth via `ANTHROPIC_API_KEY`. The orchestrator above the workers does not yet exist. The persistence schema is the next architectural decision because the orchestrator's task lifecycle, retry policy, budget accounting, and operator-visible state all assume properties of this storage layer.

Scope of this ADR: column-level schema design only. **Explicit non-goals:** ORM choice (Prisma vs. raw SQL vs. Kysely), migration tooling (Supabase CLI vs. Atlas vs. raw `psql`), RLS posture, and multi-tenancy (Version C SaaS). Each of those is a separate decision and must not be inferred from this document. The existing planning sketch in [`docs/planning/schema-proposal.md`](../planning/schema-proposal.md) was the working surface for this design; this ADR supersedes it as the architecture-of-record (the planning doc remains for historical context).

## Decision

Four tables in a dedicated schema `vibe_manager`: `tasks`, `task_dependencies`, `memory`, `events`. The orchestrator opens connections with `search_path = vibe_manager, public` so the `vector` extension (kept in `public` or `extensions`) is reachable without leaking app tables into `public`.

### `vibe_manager.tasks`

Every unit of work the orchestrator is aware of, from root task (operator-filed) down through Manager-Agent decomposition to individual worker assignments. Hierarchy is self-referential via `parent_task_id`.

| Column | Type | Null | Default | Justification |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK; UUID so the orchestrator can mint IDs before insertion. |
| `parent_task_id` | `uuid` | yes | — | FK → `tasks.id` ON DELETE CASCADE. Null at root. |
| `root_task_id` | `uuid` | no | — | FK → `tasks.id`. Equals `id` for roots, denormalized for descendants. Avoids `WITH RECURSIVE` on every "show me this run" query. |
| `title` | `text` | no | — | One-line summary, agent- or operator-authored. |
| `description` | `text` | no | — | Full task prompt / spec body. |
| `success_criteria` | `text` | yes | — | Forwarded into `TaskSpec.successCriteria` ([ADR-0001](0001-worker-agent-interface.md)). |
| `status` | `text` | no | `'pending'` | State machine vocabulary; CHECK-constrained. See §Status vocabulary below. |
| `status_reason` | `text` | yes | — | Free-form, set on every transition into a blocked or terminal state. |
| `created_by_agent` | `text` | no | — | `'human'`, `'vision'`, `'manager'`, or `'worker:<id>'`. Text rather than enum so new tiers do not require an `ALTER TYPE`. |
| `assigned_worker_type` | `text` | yes | — | E.g. `'claude-code'`. Null until a worker accepts the task. Matches `WorkerCapabilities.workerType`. |
| `assigned_session_handle` | `text` | yes | — | Opaque `SessionHandle` from `WorkerAgent.start()` ([ADR-0001](0001-worker-agent-interface.md) §Lifecycle). |
| `task_spec` | `jsonb` | yes | — | Frozen `TaskSpec` payload at assignment time. Reproducible audit. |
| `result` | `jsonb` | yes | — | Worker's `complete.result` payload (which is typed `unknown` in [ADR-0001](0001-worker-agent-interface.md), so jsonb is the natural fit). |
| `error` | `jsonb` | yes | — | Structured error if `status` is terminal-non-complete. Carries the worker's `failed` event payload including `recoverable` and `terminationMode` fields. |
| `budget_fidelity` | `text` | no | `'high'` | One of `'high'` or `'low'`. CHECK-constrained. Set by the orchestrator from the worker's token-reporting cadence ([ADR-0001](0001-worker-agent-interface.md) §Event stream). |
| `token_budget_cents` | `bigint` | yes | — | Per-task hard cap (USD cents). Null = inherit from parent or global default. |
| `tokens_spent_cents` | `bigint` | no | `0` | Updated on every `tokens` event the orchestrator consumes. `bigint` not `integer` — long subtree accumulation can exceed the ~$21M integer ceiling in pathological cases; cheap insurance. |
| `attempt_count` | `smallint` | no | `0` | Incremented on retry. |
| `created_at` | `timestamptz` | no | `now()` | |
| `started_at` | `timestamptz` | yes | — | First transition into `running`. |
| `completed_at` | `timestamptz` | yes | — | Transition into any terminal state. |

**Status vocabulary.** `CHECK (status IN ('pending', 'running', 'blocked', 'complete', 'failed', 'timed_out', 'cancelled'))`. This unifies [ADR-0001](0001-worker-agent-interface.md)'s `WorkerStatusReport.state` vocabulary across the worker and orchestrator tiers. The orchestrator-only extension is `'pending'` (task created or unblocked dependencies, not yet handed to a worker); every other value matches ADR-0001 exactly. [ADR-0001](0001-worker-agent-interface.md)'s `'starting'` worker state is **not** a separate task state — it is collapsed into `'running'` at the orchestrator's task level, because the operator's perspective is "in-flight," not "the subprocess has spawned but its first event has not yet arrived." `assigned_worker_type` plus `assigned_session_handle` carry the worker-side substate when it matters. Drift between the worker session state machine and the task state machine, if it appears in practice, is resolved by edits to this CHECK constraint; do not change ADR-0001 to match a schema choice.

**Indexes.**
- `tasks_parent_idx` on `(parent_task_id)` — children of a node.
- `tasks_root_idx` on `(root_task_id)` — fetch the full subtree for a user-visible run.
- `tasks_status_idx` on `(status)` WHERE `status IN ('pending','running','blocked')` — partial index over the hot working set.

**Concurrency.** No `version` column, no optimistic locking. v1 runs a single orchestrator process; row writes are serialized at the orchestrator layer. Consciously forecloses (a) multi-orchestrator deployments against one database, and (b) hand-editing rows via Supabase Studio mid-run. Acceptable for v1; revisit at Version C.

### `vibe_manager.task_dependencies`

Join table expressing "task A cannot start until task B reaches `complete`." Chosen over a `uuid[]` column on `tasks` for three reasons: real FKs at both ends (referential integrity), trivially enumerable in either direction (forward "what does A wait on" and reverse "what does B unblock"), and a clean place to attach future per-edge metadata (e.g., `edge_kind` for hard-vs-soft dependencies) without an `ALTER TABLE tasks`. The negative is one extra table to maintain; the positive is the operator's "what tasks does this unblock when it completes?" query — run on every task completion to advance ready successors — becomes an indexed reverse lookup instead of an array-containment scan.

| Column | Type | Null | Default | Justification |
|---|---|---|---|---|
| `task_id` | `uuid` | no | — | FK → `tasks.id` ON DELETE CASCADE. The dependent task. |
| `depends_on_task_id` | `uuid` | no | — | FK → `tasks.id` ON DELETE CASCADE. The upstream blocker. |
| `created_at` | `timestamptz` | no | `now()` | |

**Primary key:** `(task_id, depends_on_task_id)`. **Constraint:** `CHECK (task_id <> depends_on_task_id)`. Cycle detection is enforced at the orchestrator layer when the Manager Agent emits a graph; not enforced in SQL.

**Indexes.** The PK covers forward lookups. Add `task_dependencies_reverse_idx` on `(depends_on_task_id)` for the completion-advances-successors query.

### `vibe_manager.events`

Append-only audit log. Every decision, delegation, escalation, tool call, and worker event lands here.

| Column | Type | Null | Default | Justification |
|---|---|---|---|---|
| `id` | `bigserial` | no | — | PK. Monotonic ordering is part of the contract. |
| `ts` | `timestamptz` | no | `clock_timestamp()` | `clock_timestamp()` not `now()` — `now()` is transaction-stable; two events emitted in the same transaction would otherwise collide on timestamp and lose intra-transaction ordering. |
| `kind` | `text` | no | — | Variant discriminator. Text + CHECK rather than enum so new kinds (and new `WorkerEvent` variants under [ADR-0001](0001-worker-agent-interface.md)) do not require `ALTER TYPE`. |
| `task_id` | `uuid` | yes | — | FK → `tasks.id` ON DELETE SET NULL. Null for system-wide events (orchestrator boot, key rotation, etc.). |
| `root_task_id` | `uuid` | yes | — | Denormalized for "give me all events for this run." |
| `agent` | `text` | yes | — | Who produced the event. `'orchestrator'`, `'vision'`, `'manager'`, `'worker:<session_handle>'`, or `'system'`. |
| `parent_event_id` | `bigint` | yes | — | FK → `events.id`. Causal chain — a `tool_result` points at the `tool_call` it answers. |
| `payload` | `jsonb` | no | `'{}'` | Variant-specific body. TypeScript types in `src/workers/types.ts` and the forthcoming orchestrator package are the schema-of-record; the database is intentionally schemaless on this column. |
| `payload_summary` | `text` | yes | — | Optional one-line human-readable summary for `grep`-style log reading without `jsonb_path_query`. |

**Variant discrimination.** The 10 [ADR-0001](0001-worker-agent-interface.md) `WorkerEvent` variants — `heartbeat`, `log`, `progress`, `tool_call`, `tool_result`, `file_edit`, `tokens`, `blocked`, `complete`, `failed` — map onto `kind = 'worker_event:<variant>'` (e.g. `'worker_event:tokens'`). The variant-specific fields land in `payload`. Orchestrator-emitted events use distinct `kind` prefixes (`'task_*'`, `'agent_*'`, `'escalation_*'`, `'budget_*'`).

**Lossless audit of `WorkerEvent`.** Every variant's fields are JSON-serializable primitives (`number`, `string`, `boolean`, enums-as-strings) or `unknown` payloads that are JSON by construction (`complete.result`, `failed.payload`). `jsonb` represents all 10 variants without information loss, including the additive cache-token fields on `tokens` and the optional `terminationMode` on `failed` (see [`src/workers/types.ts:46-86`](../../src/workers/types.ts)).

**Tradeoff: `payload jsonb` loses column-level constraints.** A schema with one column per `WorkerEvent` variant would catch malformed events at insert time; `jsonb` shifts that validation into the orchestrator (the producer) and into TypeScript types. We accept this because the variant set evolves (the cache-token and `terminationMode` additions already happened post-[ADR-0001](0001-worker-agent-interface.md)) and per-variant tables would force a migration on every change. The orchestrator owns shape validation before insert.

**Append-only.** No `UPDATE` or `DELETE` from application code. Enforced at the orchestrator layer for v1; can be hardened with a trigger or RLS policy later. The "is the trigger worth its weight in v1" call is flagged as an open question.

**Retention.** Default **90 days**, enforced by a periodic delete (orchestrator-side or pg_cron). Operator decision: the right number depends on dogfood-phase observed event volume and on how often the operator actually replays a long-running run. The 90-day default is conservative enough for typical retrospective debugging without unbounded growth on a busy day; the figure is **flagged as an operator decision** rather than a fixed contract.

**Indexes.**
- `events_task_ts_idx` on `(task_id, ts)` — reconstruct one task's timeline (the orchestrator's primary read path).
- `events_root_ts_idx` on `(root_task_id, ts)` — reconstruct a full run for the operator.
- `events_kind_ts_idx` on `(kind, ts)` — cross-task analytics by event kind (budget warnings over time, escalation cadence, etc.).
- `events_parent_idx` on `(parent_event_id)` — causal-chain traversal.
- `events_id_brin` BRIN on `(id)` — append-only table; BRIN is essentially free and helps range scans during replay. Skip if the planner already prefers the PK.

### `vibe_manager.memory`

Semantic memory store. One row per chunk of text plus its embedding plus provenance. Reads via pgvector similarity search.

| Column | Type | Null | Default | Justification |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK. |
| `content` | `text` | no | — | The human-readable text that was embedded. Always present alongside the vector so a row remains debuggable after a model swap. |
| `summary` | `text` | yes | — | Optional one-line title for retrieval-result display without re-reading `content`. |
| `embedding` | `halfvec(3072)` | no | — | Dimension fixed to match the v1 embedding model (`text-embedding-3-large`). `halfvec` (16-bit per component) rather than `vector` so HNSW indexes at 3072 dims without ceremony; storage halves with negligible recall loss at this scale. |
| `embedding_model` | `text` | no | `'text-embedding-3-large'` | Stored per row. Mixing model versions in one HNSW index destroys recall; the column lets us re-embed during a future migration without losing provenance. |
| `kind` | `text` | no | — | Loose taxonomy: `'lesson'`, `'fact'`, `'codebase-quirk'`, `'decision'`, `'preference'`. Text + CHECK rather than enum. |
| `tier` | `text` | no | — | Which agent tier wrote this row: `'vision'`, `'manager'`, `'worker'`, or `'system'`. Distinct from `created_by_agent` in `tasks` because memory is queried by tier far more often than by individual agent identity. |
| `created_by_agent` | `text` | no | — | The specific agent that wrote this row (e.g., `'worker:claude-code:42a1...'`). |
| `task_id` | `uuid` | yes | — | FK → `tasks.id` ON DELETE SET NULL. The task this memory came from, if any. |
| `event_id` | `bigint` | yes | — | FK → `events.id` ON DELETE SET NULL. The specific event that produced this memory, if any. Provenance for memories distilled from a `complete` event's result, an escalation outcome, etc. |
| `source` | `text` | no | — | Top-level provenance category: `'task'`, `'event'`, `'external'`. Disambiguates rows where both FKs are null (`'external'` — operator-supplied or imported memory). CHECK-constrained. |
| `metadata` | `jsonb` | no | `'{}'` | Open-ended tags / paths / expiry hints. |
| `created_at` | `timestamptz` | no | `now()` | |
| `last_used_at` | `timestamptz` | yes | — | Updated whenever a retrieval surfaces this row. Lets us prune dead memories later. |

**Embedding dimension and model.** Committed to **3072-dimensional `halfvec`** matching OpenAI's `text-embedding-3-large`. The model itself is **not yet covered by a dedicated ADR** — the choice was made in `docs/planning/schema-proposal.md` and is propagated here, but the rationale (vs. `text-embedding-3-small` at 1536, or a self-hosted embedder) has not been written down. **Flagged as an open question.** The committed dimension is on the schema; switching models means a re-embed migration, not a column type change (provided the new model fits 3072 dims; otherwise the column type itself is a migration).

**Index type — HNSW.** `memory_embedding_hnsw` HNSW on `(embedding halfvec_cosine_ops)`. Justified for v1:
1. **Recall and latency over build cost.** HNSW gives better recall-at-low-k than IVFFlat at the small-to-medium row counts the dogfood phase will produce. IVFFlat wins on build time at scale and on memory footprint with very large row counts; we have neither problem yet.
2. **Halfvec at 3072 dims is HNSW-ready** in pgvector ≥ 0.7.0, which Supabase ships. IVFFlat at 3072 dims requires the same halfvec workaround and gains less from the smaller storage footprint.
3. **Reads dominate.** Memory retrieval is on every agent turn; writes are at task completion. HNSW's read-side advantage matters more than its build-side cost.

The pick may need revisiting once memory row count crosses ~1M (HNSW build/update cost rises; IVFFlat's "cheap rebuild on bulk insert" pattern becomes attractive). **Flagged as a known revisit point**, not a current open question — the data to make the call doesn't exist yet, and the table can swap index types with downtime measured in minutes at v1 volumes.

**Indexes (full set).**
- `memory_embedding_hnsw` HNSW on `(embedding halfvec_cosine_ops)` — primary retrieval.
- `memory_metadata_gin` GIN on `(metadata jsonb_path_ops)` — filtered retrieval (e.g., `metadata @> '{"repo": "matome"}'`).
- `memory_kind_idx` on `(kind)`.
- `memory_tier_idx` on `(tier)` — tier-scoped retrieval (e.g., "what does the Manager Agent know that workers don't").
- `memory_task_idx` on `(task_id)` WHERE `task_id IS NOT NULL`.

## Lossless `WorkerEvent` audit — per-variant field shape

Verified against [`src/workers/types.ts:46-86`](../../src/workers/types.ts). All field types are JSON-serializable; `jsonb payload` stores each variant losslessly.

| Variant | Fields beyond `kind` and `at` | jsonb-safe? |
|---|---|---|
| `heartbeat` | — | yes |
| `log` | `level: 'info'\|'warn'\|'error'`, `message: string` | yes |
| `progress` | `note: string` | yes |
| `tool_call` | `toolCallId: string`, `tool: string`, `argsPreview: string` | yes |
| `tool_result` | `toolCallId: string`, `ok: boolean`, `resultPreview: string` | yes |
| `file_edit` | `path: string`, `bytesChanged: number` | yes |
| `tokens` | `inputTokens: number`, `outputTokens: number`, `cacheCreationInputTokens?: number`, `cacheReadInputTokens?: number` | yes |
| `blocked` | `reason: string`, `needs: string` | yes |
| `complete` | `partial: boolean`, `result: unknown` | yes (`unknown` here is constrained to JSON by ADR-0001's "All return values are serializable" contract) |
| `failed` | `reason: string`, `recoverable: boolean`, `payload?: unknown`, `terminationMode?: 'sigterm'\|'sigkill'` | yes (same `unknown`-is-JSON constraint) |

No variant has a field that needs out-of-band binary storage, a non-JSON-serializable shape (Date objects, Buffers, Maps), or a representation that loses information in jsonb. Future `WorkerEvent` variants that introduce non-JSON-serializable fields would break this audit — the orchestrator's event-writer is the right place to enforce the constraint going forward.

## Consequences (positive)

- **Unblocks the orchestrator.** Task lifecycle, retry policy, budget accounting, and operator-facing dashboards all have a destination to read and write to.
- **Lossless audit.** Every `WorkerEvent` lands in `events` without dropping fields; replay can reconstruct what every agent saw.
- **Hierarchical task model with cheap subtree queries.** `root_task_id` denormalization removes recursive CTEs from the hot path.
- **Memory is provenance-aware.** `task_id`, `event_id`, `tier`, `source`, and `embedding_model` together let us trace any retrieved memory back to who produced it and under what model — necessary for re-embedding migrations and for debugging memory-driven decisions.
- **Vocabulary unifies with [ADR-0001](0001-worker-agent-interface.md).** `tasks.status` matches `WorkerStatusReport.state` everywhere they overlap; the orchestrator-only extension (`'pending'`) is named explicitly.
- **A→C migration is column-free.** The schema does not bake in single-tenant assumptions in column shapes (no implicit "one operator" in any FK). Adding a `tenant_id` column at Version C is additive, not a rewrite.

## Consequences (negative / tradeoffs)

- **`payload jsonb` loses column-level typing on `events`.** Malformed events fail to be caught at the database boundary. Mitigation: orchestrator validates `WorkerEvent` shape against the TypeScript types before insert; this is the only writer path.
- **Embedding dimension is committed.** Switching to a 1536-dim model means an `ALTER TABLE` plus a re-embed; switching to a different-dim model means a column type migration. The 3072 choice has not been independently justified by a dedicated ADR — see open questions.
- **Retention default of 90 days is operator-overridable but materially affects long-running root-task audit.** A root task that lives 6 months and gets replayed will lose its early events under the default. Flagged for operator decision.
- **HNSW choice may need revisiting at scale.** Build/update cost rises with row count; IVFFlat becomes competitive past ~1M rows. Mitigation: index type can be swapped with minutes of downtime at v1 volumes.
- **No row-level concurrency control on `tasks`.** Single-orchestrator deployments only. Multi-orchestrator and Supabase-Studio-mid-run are foreclosed.
- **Append-only enforcement is application-layer.** A misbehaving SQL client (or future automation) can violate the audit-log contract; the database does not stop it. Trigger-based enforcement is flagged as open.

## Open questions

Each becomes a follow-up issue and must resolve before this ADR moves from Proposed → Accepted.

1. **Embedding model selection — formal record.** The 3072-dim `text-embedding-3-large` choice is propagated from `docs/planning/schema-proposal.md` without a dedicated ADR justifying it against alternatives (`text-embedding-3-small` at 1536 dims, self-hosted bge / e5, multi-model setups). The dimension commitment on the schema makes this decision binding on the column type; needs an ADR (or a "stay with the default, here's why" written record).
2. **`events` retention default — operator decision.** 90 days proposed. Resolution requires dogfood-phase event-volume measurements and a stated retrospective-debugging horizon. The number can be a CHECK-free constant in the deletion job; the policy itself is what needs sign-off.
3. **Append-only enforcement on `events` — trigger vs. application-layer.** v1 trusts the orchestrator as the sole writer. Question: is a `BEFORE UPDATE OR DELETE` trigger that raises `EXCEPTION` worth its weight now (catches accidental Supabase-Studio mutations, future bots) versus deferred to when a real violation appears?
4. **Post-task memory summarizer — synchronous or deferred.** Affects perceived task latency and operator-visible state in the dashboard. Sync = simpler causality (task `complete` implies memory written) at the cost of latency on the operator's "task done?" view. Deferred = faster perceived completion at the cost of a window where a `complete` task has no associated memory rows.
5. **Soft-delete / "forget task" path.** No `deleted_at` columns in this proposal. If we ever need to remove a task for legal or operator reasons, do we hard-delete with cascades (events go with the task, memory rows orphan to `task_id = NULL`), or add a soft-delete flag and filter everywhere? Defer until someone asks; track the question so we don't bake in a hard-delete assumption that gets painful later.
6. **`tasks.status` vocabulary drift detection.** [ADR-0001](0001-worker-agent-interface.md)'s `WorkerStatusReport.state` and this ADR's `tasks.status` are intentionally aligned today, but future worker states would require a CHECK update here and a documentation pass to keep them in sync. Question: do we add a test that asserts the two vocabularies are equal modulo the orchestrator-only `'pending'` extension, or rely on review discipline?

## What this defers

Not goals of this ADR; future decisions required:

- **ORM choice.** Prisma, Kysely, raw `pg`, or none of the above. The schema is ORM-independent; the choice is a separate ADR.
- **Migration tooling.** Supabase CLI, Atlas, sqitch, or raw `psql` scripts checked into the repo. Independent decision.
- **RLS policies.** This ADR does not turn on row-level security or write any policies. v1 is single-tenant on a trusted Supabase project; RLS becomes relevant at Version C and gets its own ADR.
- **Multi-tenancy (Version C SaaS).** No `tenant_id` columns; no per-tenant key/encryption story. Additive when Version C lands.
- **Operator dashboard query patterns.** Indexes here are sized for the orchestrator's reads, not for ad-hoc operator analytics. Additional indexes may be warranted once operator query patterns settle.

## Amendments — 2026-06-11 (plan checkpoint #50)

Gate decisions from the re-pour run's step-1 review. Items marked *(migration-bound)* are decided here but their issues close when the step-2 migration PR lands the SQL; doc-only items close with this amendment.

### Resolved by this amendment

- **#33 — embedding model, formal record.** Stay with `text-embedding-3-large` at 3072-dim `halfvec`. Rationale: highest-recall OpenAI-family model; `halfvec` halves storage and is HNSW-ready at 3072 dims on pgvector ≥ 0.7 (which the migration asserts); the `embedding_model` column already provides the re-embed migration path. Re-evaluation triggers, named: embedding spend becomes visible in dogfood data; row count approaches ~1M; a self-hosting requirement appears. Alternatives considered are recorded in #33 itself.
  **Operational dependency, previously unstated:** this commits an otherwise all-Anthropic stack to a second vendor when the memory pipeline lands (M4b) — an OpenAI API key in the daemon environment (never in the worker env allowlist), a second billing surface *outside* the Anthropic $500 console cap, and operator-owned key rotation. No key is needed until M4b ships an embedder; the migration creates the column, not the dependency.
- **#43 — `status_reason` semantics.** `status_reason` is the *current* reason only, overwritten on every transition. For transition history, query `events` filtered by `task_id` and `kind = 'task_status_change'`.
- **#44 — `task_spec` audit guarantee.** Option (a): the rendered worker prompt is stored verbatim in `task_spec` (`task_spec.renderedPrompt`) at dispatch time. "What was sent to the worker" is reproducible from the row alone, independent of prompt-rendering code drift; the jsonb size cost is accepted at v1 volume.
- **#45 — `memory.event_id` provenance is soft by design.** Events retention nulls it (`ON DELETE SET NULL`); the memory row is the durable artifact, the event was the trigger. Intentional, now stated.
- **#46 — `memory.last_used_at` write-amplification.** Known scaling concern, added to Consequences: every retrieval is a SELECT + UPDATE. Fine at v1 volume; batch or defer the write-back when retrieval QPS warrants.
- **WAN write-failure posture** (review F9). v1 accepts remote Supabase over WAN from an unattended laptop. Dispatcher policy: bounded retry (3×, backoff) on write failure, then **fail the affected task loudly** — events are never silently dropped and the daemon never limps past a persistence error. Connection mode must be session/direct (port 5432): session-scoped server state and LISTEN/NOTIFY do not survive Supavisor transaction pooling. The pool installs an idle-client error handler (a Supabase maintenance restart must not crash the daemon). Local-Postgres re-platforming was considered and rejected — the operator's constraint locks Supabase, and the schema is identical either way.
- **Secrets at rest** (review F21). `task_spec.renderedPrompt` and event payloads persist verbatim to a WAN-hosted database with RLS disabled (#47). Accepted for v1 (single tenant, founder-owned repos, single connection string); named here beside the OpenAI-key note so it is a decision. The RLS ADR (deferred) revisits at Version C.

### Migration-bound decisions (recorded now; issues close with the step-2 migration PR)

- **#41 — `tokens_spent_cents` type.** Option (a): `numeric(20,8)` fractional cents. Lossless at Anthropic's ~0.0003-cents-per-token granularity; raw token counts remain in `events` for recomputation against future pricing tables.
- **#42 — `idempotency_key text UNIQUE` (nullable) on `tasks`.** Cheap now, painful to retrofit. This — not session-scoped advisory locks, which Supavisor renders meaningless — is the restart/concurrent-run dedup primitive.
- **#35 — append-only enforcement.** Database-level guard now: a `BEFORE UPDATE OR DELETE` trigger on `events` raising an exception. Carve-out mechanics matter: `SECURITY DEFINER` does **not** bypass triggers, so the trigger checks a GUC (`current_setting('vibe_manager.allow_prune', true)`) and `prune_events(retention interval)` does `SET LOCAL vibe_manager.allow_prune = 'on'` inside its transaction. Migration tests assert the trio: UPDATE blocked, raw DELETE blocked, prune succeeds. No scheduled prune job ships in this run (see parked #34).
- **#47 — RLS.** The migration explicitly disables row-level security on all four tables, with a comment pointing at the deferred RLS ADR. (Supabase tooling enables RLS by default; without this, service-role queries fail with opaque permission errors on first deploy.)
- **New: `events.dedupe_key uuid UNIQUE`** (client-minted). Writes use `ON CONFLICT DO NOTHING`, and `tokens_spent_cents` is derived idempotently in the same transaction as the event insert — a retried ambiguous write (WAN timeout that actually committed) can neither duplicate the audit log nor double-count spend.
- **Migration tooling** (was an explicit non-goal of this ADR; small decision recorded): plain SQL files in `supabase/migrations/`, applied with the Supabase CLI; a paired `_down.sql` ships with each migration. No ORM — the orchestrator uses `pg` with hand-written parameterized SQL; the ORM question stays a deferred ADR. Migration 0001 opens with a `DO` block asserting pgvector ≥ 0.7 with a human-readable error.

### Still parked (genuinely need a running orchestrator; NOT resolved — ADR stays Proposed)

- **#34 — events retention default.** Needs observed event volume from real runs; `prune_events()` is parameterized and unscheduled; 90 days remains the documented provisional figure.
- **#36 — post-task memory summarizer timing.** No summarizer exists until M4b; the sync-vs-deferred answer depends on whether the Manager's next task consumes the prior task's memory, unobservable until decomposition runs for real.
- **#37 — soft-delete / forget-task path.** Version C compliance question; nothing in the migration forecloses adding `deleted_at` later. Hard-delete-with-documented-cascades stays the v1 default.

## References

- [`docs/vision.md`](../vision.md) — open question #1 ("concrete Postgres schema for `tasks`, `memory`, `events` tables") resolved here.
- [ADR-0001](0001-worker-agent-interface.md) — WorkerAgent Interface Contract. Defines `WorkerEvent` taxonomy and `WorkerStatusReport.state` vocabulary that this schema audits losslessly and unifies with.
- [ADR-0002](0002-worker-auth-api-key.md) — Worker Authentication via `ANTHROPIC_API_KEY`. Establishes the credential delivery channel; not modified by this ADR.
- [`docs/planning/schema-proposal.md`](../planning/schema-proposal.md) — prior planning draft; this ADR supersedes it as the architecture-of-record.
- [`src/workers/types.ts`](../../src/workers/types.ts) — `WorkerEvent` union the `events.payload` column must accommodate.
- Follow-up issues (all must resolve before Proposed → Accepted). Issues #33–#38 were filed alongside the ADR's initial draft; issues #41–#47 were surfaced during operator review and are additional pre-Accepted gates against the same Status.
  - [#33](https://github.com/Arcadiann/vibe-manager/issues/33) — embedding model selection (formal record).
  - [#34](https://github.com/Arcadiann/vibe-manager/issues/34) — `events` retention default.
  - [#35](https://github.com/Arcadiann/vibe-manager/issues/35) — append-only enforcement on `events`.
  - [#36](https://github.com/Arcadiann/vibe-manager/issues/36) — post-task memory summarizer timing.
  - [#37](https://github.com/Arcadiann/vibe-manager/issues/37) — soft-delete / forget-task path.
  - [#38](https://github.com/Arcadiann/vibe-manager/issues/38) — `tasks.status` ↔ ADR-0001 vocabulary drift detection.
  - [#41](https://github.com/Arcadiann/vibe-manager/issues/41) — schema fix: `tokens_spent_cents` bigint rounds individual tokens to zero.
  - [#42](https://github.com/Arcadiann/vibe-manager/issues/42) — task `idempotency_key` for restart-mid-run dedup.
  - [#43](https://github.com/Arcadiann/vibe-manager/issues/43) — clarification: `status_reason` is current-only; use `events` for transition history.
  - [#44](https://github.com/Arcadiann/vibe-manager/issues/44) — audit guarantee: `task_spec` vs rendered worker prompt.
  - [#45](https://github.com/Arcadiann/vibe-manager/issues/45) — docs: `memory.event_id` provenance is soft (events retention nulls it).
  - [#46](https://github.com/Arcadiann/vibe-manager/issues/46) — forward-flag: `memory.last_used_at` write-amplification at scale.
  - [#47](https://github.com/Arcadiann/vibe-manager/issues/47) — migration constraint: explicitly disable RLS on `vibe_manager` tables.
