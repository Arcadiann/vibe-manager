-- 0001_vibe_manager_init.sql
-- ADR-0003 (as amended 2026-06-11, plan checkpoint #50): tasks,
-- task_dependencies, events, memory in a dedicated `vibe_manager` schema.
-- Gate decisions baked in: #41 numeric(20,8) spend, #42 idempotency_key,
-- #35 GUC-gated append-only trigger + prune, #47 explicit RLS disable,
-- events.dedupe_key for idempotent writes.
-- Down migration: 0001_vibe_manager_init_down.sql

-- Supabase installs pgvector into the `extensions` schema; plain Postgres
-- uses `public`. Either way the unqualified halfvec type below must resolve.
-- (Missing schemas in search_path are ignored, so this is safe on both.)
set search_path = public, extensions;

-- pgvector >= 0.7 is required for HNSW over halfvec(3072) (DX F3: fail with
-- a readable message instead of an opaque index error mid-migration).
do $$
declare v text;
begin
  select extversion into v from pg_extension where extname = 'vector';
  if v is null then
    begin
      create extension vector;
      select extversion into v from pg_extension where extname = 'vector';
    exception when others then
      raise exception 'pgvector extension is not installed and could not be created: %', sqlerrm;
    end;
  end if;
  if string_to_array(v, '.')::int[] < array[0,7] then
    raise exception
      'pgvector >= 0.7.0 required for HNSW over halfvec(3072); found %. Upgrade the extension in the Supabase dashboard (Database > Extensions).', v;
  end if;
end $$;

create schema if not exists vibe_manager;

-- ───────────────────────── tasks ─────────────────────────
create table vibe_manager.tasks (
  id                      uuid primary key default gen_random_uuid(),
  parent_task_id          uuid references vibe_manager.tasks(id) on delete cascade,
  root_task_id            uuid not null references vibe_manager.tasks(id),
  title                   text not null,
  description             text not null,
  success_criteria        text,
  -- Vocabulary unified with ADR-0001's worker state machine plus the
  -- orchestrator-only 'pending' (ADR-0003 §status vocabulary). The #38 drift
  -- test asserts this CHECK matches the orchestrator's TASK_STATUSES const.
  status                  text not null default 'pending'
                          check (status in ('pending','running','blocked','complete','failed','timed_out','cancelled')),
  status_reason           text,  -- current-only; transition history lives in events (#43)
  created_by_agent        text not null,
  assigned_worker_type    text,
  assigned_session_handle text,
  -- Frozen at dispatch; includes renderedPrompt verbatim per #44 option (a).
  task_spec               jsonb,
  result                  jsonb,
  error                   jsonb,
  budget_fidelity         text not null default 'high' check (budget_fidelity in ('high','low')),
  token_budget_cents      numeric(20,8),
  -- #41: fractional cents — bigint rounds individual tokens to zero and
  -- systematically undercounts spend. Raw token counts remain in events.
  tokens_spent_cents      numeric(20,8) not null default 0,
  -- #42: restart-mid-run / concurrent-invocation dedup primitive (session
  -- advisory locks are meaningless through Supavisor pooling).
  idempotency_key         text unique,
  attempt_count           smallint not null default 0,
  created_at              timestamptz not null default now(),
  started_at              timestamptz,
  completed_at            timestamptz
);

create index tasks_parent_idx on vibe_manager.tasks (parent_task_id);
create index tasks_root_idx   on vibe_manager.tasks (root_task_id);
create index tasks_status_idx on vibe_manager.tasks (status)
  where status in ('pending','running','blocked');

-- ──────────────────── task_dependencies ──────────────────
create table vibe_manager.task_dependencies (
  task_id            uuid not null references vibe_manager.tasks(id) on delete cascade,
  depends_on_task_id uuid not null references vibe_manager.tasks(id) on delete cascade,
  created_at         timestamptz not null default now(),
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id)
);

-- Reverse lookup: "what does this completion unblock" — run on every task
-- completion to advance ready successors.
create index task_dependencies_reverse_idx on vibe_manager.task_dependencies (depends_on_task_id);

-- ───────────────────────── events ────────────────────────
create table vibe_manager.events (
  id              bigint generated always as identity primary key,
  -- clock_timestamp() not now(): now() is transaction-stable and would
  -- collapse intra-transaction ordering between two events.
  ts              timestamptz not null default clock_timestamp(),
  kind            text not null,
  task_id         uuid references vibe_manager.tasks(id) on delete set null,
  root_task_id    uuid,
  agent           text,
  parent_event_id bigint references vibe_manager.events(id),
  payload         jsonb not null default '{}',
  payload_summary text,
  -- Client-minted idempotency key: a retried ambiguous write (WAN timeout
  -- that actually committed) must not duplicate the audit log or
  -- double-count spend (plan §4b-9). Writers use ON CONFLICT DO NOTHING.
  dedupe_key      uuid unique
);

create index events_task_ts_idx on vibe_manager.events (task_id, ts);
create index events_root_ts_idx on vibe_manager.events (root_task_id, ts);
create index events_kind_ts_idx on vibe_manager.events (kind, ts);
create index events_parent_idx  on vibe_manager.events (parent_event_id);

-- #35: append-only enforced in the database, not just by writer discipline.
-- SECURITY DEFINER does NOT bypass triggers — the sanctioned delete path is
-- a GUC the prune function sets transaction-locally. Catches Supabase-Studio
-- edits and future automation from day one.
create function vibe_manager.events_append_only() returns trigger
language plpgsql as $$
begin
  if current_setting('vibe_manager.allow_prune', true) is distinct from 'on' then
    raise exception 'vibe_manager.events is append-only (ADR-0003 #35); use vibe_manager.prune_events()';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create trigger events_append_only_guard
  before update or delete on vibe_manager.events
  for each row execute function vibe_manager.events_append_only();

-- The single sanctioned delete path. Retention is a PARAMETER — the default
-- figure (90d, provisional) is an operator decision parked as #34 and no
-- scheduled job ships in this run.
create function vibe_manager.prune_events(retention interval) returns bigint
language plpgsql security definer as $$
declare n bigint;
begin
  perform set_config('vibe_manager.allow_prune', 'on', true);  -- SET LOCAL semantics
  delete from vibe_manager.events where ts < now() - retention;
  get diagnostics n = row_count;
  return n;
end $$;

-- ───────────────────────── memory ────────────────────────
-- Schema ships now (ADR-0003 / mission constraint); the write/retrieval
-- pipeline is M4b — no embedder, and therefore no OpenAI key, until then
-- (#33 amendment records the operational dependency).
create table vibe_manager.memory (
  id               uuid primary key default gen_random_uuid(),
  content          text not null,
  summary          text,
  embedding        halfvec(3072) not null,
  embedding_model  text not null default 'text-embedding-3-large',
  kind             text not null check (kind in ('lesson','fact','codebase-quirk','decision','preference')),
  tier             text not null check (tier in ('vision','manager','worker','system')),
  created_by_agent text not null,
  task_id          uuid references vibe_manager.tasks(id) on delete set null,
  -- Soft provenance by design: events retention nulls it; the memory row is
  -- the artifact (#45).
  event_id         bigint references vibe_manager.events(id) on delete set null,
  source           text not null check (source in ('task','event','external')),
  metadata         jsonb not null default '{}',
  created_at       timestamptz not null default now(),
  -- Known scaling concern (#46): retrieval write-amplification; batch or
  -- defer the write-back when retrieval QPS warrants.
  last_used_at     timestamptz
);

create index memory_embedding_hnsw on vibe_manager.memory using hnsw (embedding halfvec_cosine_ops);
create index memory_metadata_gin   on vibe_manager.memory using gin (metadata jsonb_path_ops);
create index memory_kind_idx       on vibe_manager.memory (kind);
create index memory_tier_idx       on vibe_manager.memory (tier);
create index memory_task_idx       on vibe_manager.memory (task_id) where task_id is not null;

-- #47: Supabase tooling enables RLS by default on new tables; without an
-- explicit disable, service-role queries fail with opaque permission errors
-- on first deploy. RLS posture is a deferred ADR (Version C concern).
alter table vibe_manager.tasks             disable row level security;
alter table vibe_manager.task_dependencies disable row level security;
alter table vibe_manager.events            disable row level security;
alter table vibe_manager.memory            disable row level security;
