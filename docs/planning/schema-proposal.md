# Postgres Schema Proposal (v1)

Proposal only — no SQL files, no migrations. This document is the design surface; the migration lands in M2.

All tables live in a dedicated schema `vibe_manager`, never `public`. The orchestrator opens connections with `search_path = vibe_manager, public` so referencing `extensions.vector` from the `public` schema works without leaking app tables.

Three tables plus one join table: `tasks`, `task_dependencies`, `memory`, `events`.

---

## `vibe_manager.tasks`

Tracks every unit of work the orchestrator is aware of, from root task (the operator's input) down through Manager decomposition to individual worker assignments. Hierarchical via self-referential `parent_task_id`.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `parent_task_id` | `uuid` | yes | — | FK → `tasks.id` `on delete cascade`. Null = root task. |
| `root_task_id` | `uuid` | no | (same as `id` for roots; set on insert otherwise) | FK → `tasks.id`. Denormalized for fast subtree queries; avoids recursive CTEs in hot paths. |
| `title` | `text` | no | — | One-line summary, agent-authored. |
| `description` | `text` | no | — | Full task prompt / spec. |
| `success_criteria` | `text` | yes | — | What "done" means for this task; passed to worker. |
| `status` | `text` | no | `'pending'` | One of `pending`, `assigned`, `running`, `blocked`, `complete`, `failed`, `cancelled`. Enforced by `CHECK (status IN (...))`. Text not enum so we can add states without an `ALTER TYPE`. |
| `status_reason` | `text` | yes | — | Free-form, set whenever status moves to a terminal or blocked state. |
| `created_by_agent` | `text` | no | — | `'vision'`, `'manager'`, `'worker:<id>'`, or `'human'` for root. |
| `assigned_worker_type` | `text` | yes | — | E.g. `'claude-code'`. Null until assigned. |
| `assigned_session_handle` | `text` | yes | — | Opaque `WorkerAgent` session handle once started. |
| `task_spec` | `jsonb` | yes | — | Full `TaskSpec` payload sent to the worker (frozen at assignment time). |
| `result` | `jsonb` | yes | — | Worker's structured completion payload. |
| `error` | `jsonb` | yes | — | Structured error if `status = failed`. |
| `budget_fidelity` | `text` | no | `'high'` | One of `high`, `low`. Set by the orchestrator based on the worker's token-reporting cadence (see ADR-0001). `CHECK (budget_fidelity IN ('high','low'))`. |
| `token_budget_cents` | `bigint` | yes | — | Per-task hard cap in cents. Null = inherit from parent or global default. |
| `tokens_spent_cents` | `bigint` | no | `0` | Updated by orchestrator from worker events. Computed-on-write rather than recomputed-on-read because workers stream events fast. `bigint` rather than `integer` to give headroom (an integer caps at \~\$21M of cumulative spend; cheap insurance against subtree-level accumulator overflow in long-running roots). |
| `attempt_count` | `smallint` | no | `0` | Increment on retry. |
| `created_at` | `timestamptz` | no | `now()` | |
| `started_at` | `timestamptz` | yes | — | First transition to `running`. |
| `completed_at` | `timestamptz` | yes | — | Transition to a terminal state. |

**Indexes.**
- `tasks_parent_idx` on `(parent_task_id)` — list children of a node.
- `tasks_root_idx` on `(root_task_id)` — fetch full subtree for a user-visible run.
- `tasks_status_idx` on `(status)` `where status in ('pending','assigned','running','blocked')` — partial index over the small hot set.

**Non-obvious column rationale.**
- **`root_task_id`** avoids `WITH RECURSIVE` on every "show me this run" query. Slightly redundant but cheap to maintain.
- **`task_spec`** is frozen at assignment so the audit trail is reproducible even if the orchestrator changes how it builds specs.
- **`status` and `budget_fidelity` as text + `CHECK`** match the rationale already given for `events.kind`: small, evolving vocabularies, and we don't want an `ALTER TYPE` every time we add a state.
- **`tokens_spent_cents` as bigint** — see column note. Integer is too tight for subtree accumulation in long-running operator sessions.

**No row-level concurrency control.** This schema has no `version` column, no `xmin` checks, no optimistic-locking ceremony. v1 runs a single orchestrator process; row writes are serialized at the orchestrator layer, not the database. This is intentional and consciously forecloses two things: (a) running multiple concurrent orchestrators against the same database (they'd race on `tasks.status` transitions with no detection), and (b) hand-editing rows via Supabase Studio during a live run (could collide with an in-flight transition). Both are acceptable losses for v1. If we ever need either, add a `version integer` column and bump it on every `UPDATE`.

---

## `vibe_manager.task_dependencies`

Join table expressing "task A cannot start until task B reaches `complete`." One row per edge.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `task_id` | `uuid` | no | — | FK → `tasks.id` `on delete cascade`. The dependent task. |
| `depends_on_task_id` | `uuid` | no | — | FK → `tasks.id` `on delete cascade`. The upstream task that must complete first. |
| `created_at` | `timestamptz` | no | `now()` | |

**Primary key:** `(task_id, depends_on_task_id)`.

**Constraints.**
- `CHECK (task_id <> depends_on_task_id)` — no self-loops.
- Cycle detection is enforced at the orchestrator layer when the Manager Agent emits a graph; not enforced in SQL.

**Indexes.**
- The PK already covers `(task_id, depends_on_task_id)` — sufficient for "what does this task wait on?"
- `task_dependencies_reverse_idx` on `(depends_on_task_id)` — for "what tasks does this unblock when it completes?" The orchestrator runs this query on every task completion to advance ready successors.

**Rationale for join table over `uuid[]`.** Real FKs (both ends), trivially enumerable in either direction, no array gymnastics in queries, and a clean place to attach future per-edge metadata (e.g., `edge_kind` for hard-vs-soft dependencies) without a column migration on `tasks`.

---

## `vibe_manager.memory`

Semantic memory store. Every row is one chunk of text plus its embedding plus provenance. Reads happen via pgvector similarity search; writes happen at the end of meaningful agent turns.

Depends on the `vector` extension (already available on Supabase).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `content` | `text` | no | — | The human-readable text that was embedded. Always present alongside the vector. |
| `summary` | `text` | yes | — | Optional one-line title (helps debugging without re-reading `content`). |
| `embedding` | `halfvec(3072)` | no | — | Dimension fixed to match `text-embedding-3-large` (the chosen embedding model for v1). `halfvec` (16-bit per component) rather than `vector` so HNSW indexing works out of the box at 3072 dims; storage halves with negligible recall loss at this scale. |
| `embedding_model` | `text` | no | `'text-embedding-3-large'` | Stored per-row so we can re-embed on model swaps without losing provenance, and so heterogeneous rows (during a future migration) are still traceable to the model that produced them. |
| `kind` | `text` | no | — | Loose taxonomy: `'lesson'`, `'fact'`, `'codebase-quirk'`, `'decision'`, `'preference'`. Not an enum so we can evolve without a migration. |
| `created_by_agent` | `text` | no | — | Which agent wrote this memory. |
| `task_id` | `uuid` | yes | — | FK → `tasks.id` `on delete set null`. The task this memory came from, if any. |
| `metadata` | `jsonb` | no | `'{}'` | Open-ended: tags, source-of-truth paths, expiry hints, etc. |
| `created_at` | `timestamptz` | no | `now()` | |
| `last_used_at` | `timestamptz` | yes | — | Updated whenever a retrieval surfaces this row. Lets us prune dead memories later. |

**Indexes.**
- `memory_embedding_hnsw` HNSW on `(embedding halfvec_cosine_ops)` — primary retrieval path. The column is `halfvec(3072)` directly (not a `vector(3072)` indexed via expression), so HNSW works without ceremony. M2 confirms the Supabase pgvector version is ≥ 0.7.0 (halfvec support) before applying the migration.
- `memory_metadata_gin` GIN on `(metadata jsonb_path_ops)` — filtered retrieval (e.g., `metadata @> '{"repo": "matome"}'`).
- `memory_kind_idx` on `(kind)` — filter by memory kind.
- `memory_task_idx` on `(task_id)` — find all memories from a given task.

**Non-obvious column rationale.**
- **`embedding_model`** is essential: mixing dimensions or model versions in one HNSW index destroys recall. When the model changes, we backfill, we don't merge. Default `'text-embedding-3-large'` codifies the v1 choice; rows produced by other models (e.g., during a future migration) MUST override the default explicitly.
- **`last_used_at`** is the only mutable column. Tracks which memories actually pay rent.

---

## `vibe_manager.events`

Append-only audit log. Every decision, delegation, escalation, tool call, and worker event lands here. The source of truth for "why did this happen at 2am."

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `bigserial` | no | — | PK. Monotonic ordering is part of the contract. |
| `ts` | `timestamptz` | no | `clock_timestamp()` | `clock_timestamp` not `now()` — `now()` is transaction-stable and would give two events in the same transaction identical timestamps. |
| `kind` | `text` | no | — | E.g. `'task_created'`, `'task_assigned'`, `'agent_decision'`, `'tool_call'`, `'worker_event'`, `'escalation_sent'`, `'escalation_resolved'`, `'budget_warning'`. Loose taxonomy; new kinds don't need a migration. |
| `task_id` | `uuid` | yes | — | FK → `tasks.id` `on delete set null`. Null for system-wide events (e.g., orchestrator boot). |
| `root_task_id` | `uuid` | yes | — | Denormalized for "give me all events for this run." |
| `agent` | `text` | yes | — | Who/what produced the event. |
| `parent_event_id` | `bigint` | yes | — | FK → `events.id`. Causal chain (e.g., `tool_call` → `tool_result`). |
| `payload` | `jsonb` | no | `'{}'` | Event-kind-specific body. Schema lives in TypeScript types, not the DB. |
| `payload_summary` | `text` | yes | — | Human-readable one-liner for log grepping without `jsonb_path_query`. Optional. |

**Indexes.**
- `events_task_ts_idx` on `(task_id, ts)` — reconstruct one task's timeline.
- `events_root_ts_idx` on `(root_task_id, ts)` — reconstruct a full run.
- `events_kind_idx` on `(kind)` — kind-faceted analytics later.
- `events_id_brin` BRIN on `(id)` — append-only table; BRIN is essentially free and helps range scans for replay. Skip if the planner already prefers the PK.

**Append-only contract.**
- No `UPDATE` or `DELETE` from application code. Enforced at the orchestrator layer; can be hardened later with a trigger or row-level security if needed. Not worth the ceremony for v1.

**Non-obvious column rationale.**
- **`clock_timestamp()` default** — see comment above. Critical for ordering within a transaction.
- **`root_task_id`** — same denormalization rationale as in `tasks`.
- **`parent_event_id`** — workers emit a `tool_call` event, then a `tool_result`; the link is explicit rather than inferred from adjacency.

---

## Vision-brief ambiguities (resolved here)

The vision brief left several persistence-vs-computation choices unspecified. Resolutions:

1. **Memory writes — automatic AND explicit.** Both paths land. A post-task summarizer runs at task completion and writes any extractable lessons. Agents may additionally call an orchestrator-side `remember(...)` callable to deliberately persist a discovery they want surfaced later. The schema accommodates both via `created_by_agent` and `kind`.
2. **Per-task budget accounting.** Tracked at the task level via `tasks.tokens_spent_cents`. Subtree totals (parent + all descendants) are computed on demand from `root_task_id` rather than denormalized — this avoids cascading writes on every leaf-task update and matches how the operator-facing dashboards will actually query.
3. **Worker output streaming destination.** Vision question #2. The schema captures worker output via `events` (kind=`worker_event`) regardless of transport; the streaming mechanism is an ADR-0001 implementation choice, not a schema choice.
4. **Dependencies (resolved).** Now a `task_dependencies` join table, not an array column.
5. **Embedding dimension (resolved).** `vector(3072)`, model `text-embedding-3-large`.
6. **Soft-deletes.** Nothing in this proposal has a `deleted_at` column. The brief is silent on retention. If we ever want to "forget" a task (e.g., legal), we need either hard delete with cascades or a soft-delete flag. Defer until someone asks.

---

## Open questions

- Whether to enforce append-only on `events` via trigger now or trust orchestrator code for v1.
- Whether the post-task memory summarizer should run synchronously at task completion or as a deferred background job (affects perceived task latency and operator-visible state).
