# Postgres Schema Proposal (v1)

Proposal only — no SQL files, no migrations. This document is the design surface; the migration lands in M2.

All tables live in a dedicated schema `vibe_manager`, never `public`. The orchestrator opens connections with `search_path = vibe_manager, public` so referencing `extensions.vector` from the `public` schema works without leaking app tables.

Three tables: `tasks`, `memory`, `events`.

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
| `status` | `task_status` | no | `'pending'` | Enum: `pending`, `assigned`, `running`, `blocked`, `complete`, `failed`, `cancelled`. |
| `status_reason` | `text` | yes | — | Free-form, set whenever status moves to a terminal or blocked state. |
| `created_by_agent` | `text` | no | — | `'vision'`, `'manager'`, `'worker:<id>'`, or `'human'` for root. |
| `assigned_worker_type` | `text` | yes | — | E.g. `'claude-code'`. Null until assigned. |
| `assigned_session_handle` | `text` | yes | — | Opaque `WorkerAgent` session handle once started. |
| `depends_on` | `uuid[]` | no | `'{}'` | Sibling task IDs that must reach `complete` before this can run. See open question below. |
| `task_spec` | `jsonb` | yes | — | Full `TaskSpec` payload sent to the worker (frozen at assignment time). |
| `result` | `jsonb` | yes | — | Worker's structured completion payload. |
| `error` | `jsonb` | yes | — | Structured error if `status = failed`. |
| `token_budget_cents` | `integer` | yes | — | Per-task hard cap in cents. Null = inherit from parent or global default. |
| `tokens_spent_cents` | `integer` | no | `0` | Updated by orchestrator from worker events. Computed-on-write rather than recomputed-on-read because workers stream events fast. |
| `attempt_count` | `smallint` | no | `0` | Increment on retry. |
| `created_at` | `timestamptz` | no | `now()` | |
| `started_at` | `timestamptz` | yes | — | First transition to `running`. |
| `completed_at` | `timestamptz` | yes | — | Transition to a terminal state. |

**Indexes.**
- `tasks_parent_idx` on `(parent_task_id)` — list children of a node.
- `tasks_root_idx` on `(root_task_id)` — fetch full subtree for a user-visible run.
- `tasks_status_idx` on `(status)` `where status in ('pending','assigned','running','blocked')` — partial index over the small hot set.
- `tasks_depends_on_gin` GIN on `(depends_on)` — find unblocked tasks (`where not depends_on && unfinished_set`). Worth measuring before committing.

**Non-obvious column rationale.**
- **`root_task_id`** avoids `WITH RECURSIVE` on every "show me this run" query. Slightly redundant but cheap to maintain.
- **`task_spec`** is frozen at assignment so the audit trail is reproducible even if the orchestrator changes how it builds specs.
- **`tokens_spent_cents` as integer** sidesteps numeric precision issues; integer cents is the standard.

---

## `vibe_manager.memory`

Semantic memory store. Every row is one chunk of text plus its embedding plus provenance. Reads happen via pgvector similarity search; writes happen at the end of meaningful agent turns.

Depends on the `vector` extension (already available on Supabase).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `content` | `text` | no | — | The human-readable text that was embedded. Always present alongside the vector. |
| `summary` | `text` | yes | — | Optional one-line title (helps debugging without re-reading `content`). |
| `embedding` | `vector(1536)` | no | — | See open question on dimension. |
| `embedding_model` | `text` | no | — | E.g. `'text-embedding-3-small'`. Stored per-row so we can re-embed on model swaps without losing provenance. |
| `kind` | `text` | no | — | Loose taxonomy: `'lesson'`, `'fact'`, `'codebase-quirk'`, `'decision'`, `'preference'`. Not an enum so we can evolve without a migration. |
| `created_by_agent` | `text` | no | — | Which agent wrote this memory. |
| `task_id` | `uuid` | yes | — | FK → `tasks.id` `on delete set null`. The task this memory came from, if any. |
| `metadata` | `jsonb` | no | `'{}'` | Open-ended: tags, source-of-truth paths, expiry hints, etc. |
| `created_at` | `timestamptz` | no | `now()` | |
| `last_used_at` | `timestamptz` | yes | — | Updated whenever a retrieval surfaces this row. Lets us prune dead memories later. |

**Indexes.**
- `memory_embedding_hnsw` HNSW on `(embedding vector_cosine_ops)` — primary retrieval path. HNSW preferred over IVFFlat for read-heavy semantic search at small-to-mid scale.
- `memory_metadata_gin` GIN on `(metadata jsonb_path_ops)` — filtered retrieval (e.g., `metadata @> '{"repo": "matome"}'`).
- `memory_kind_idx` on `(kind)` — filter by memory kind.
- `memory_task_idx` on `(task_id)` — find all memories from a given task.

**Non-obvious column rationale.**
- **`embedding_model`** is essential: mixing dimensions or model versions in one HNSW index destroys recall. When the model changes, we backfill, we don't merge.
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

## Vision-brief ambiguities flagged

These are places the vision brief is unclear about what should be persisted vs. computed. None block the proposal, but each is worth a 60-second decision before M2.

1. **Memory writes — automatic or explicit?** The brief says memory is "available to all agents on read" but doesn't say who writes and when. The schema supports either path. Implication: M4 has to decide whether agents emit `remember(...)` calls explicitly or whether a post-task summarizer runs on every completion.
2. **Per-task budget accounting.** The brief specifies a $20/task default in the router rubric but doesn't define whether token cost is tracked at the worker level only, the subtree level (parent + descendants), or both. The schema lets us do either; orchestrator needs to pick. Proposal: track at the task level, compute subtree totals on demand from `root_task_id`.
3. **Worker output streaming destination.** Vision question #2. The schema captures worker output via `events` (kind=`worker_event`) regardless of transport; the streaming mechanism is an M3 implementation choice, not a schema choice.
4. **Dependencies as array vs. join table.** `depends_on uuid[]` is simpler and adequate for v1 task graphs (expected < 50 nodes per run). A join table would scale better but isn't necessary yet. Flagging because it's the kind of decision that's annoying to reverse — but reversible with a one-shot migration. Recommend array for now.
5. **Memory dimension.** `vector(1536)` matches OpenAI's `text-embedding-3-small`. If we want to use Voyage (`voyage-3` is 1024) or `text-embedding-3-large` (3072), we change the column type. The `embedding_model` column is forward-compatible; the dimension is not. Suggest deciding before M4.
6. **Soft-deletes.** Nothing in this proposal has a `deleted_at` column. The brief is silent on retention. If we ever want to "forget" a task (e.g., legal), we need either hard delete with cascades or a soft-delete flag. Defer until someone asks.

---

## Open questions

- Dimension for the embedding column (1024 / 1536 / 3072 — depends on embedding model choice).
- Whether to enforce append-only on `events` via trigger now or trust orchestrator code for v1.
- Whether `depends_on` should be a join table now (cheap insurance) or `uuid[]` (simpler, reversible).
