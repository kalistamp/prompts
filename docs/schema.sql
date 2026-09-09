-- ============================================================
-- PROMPT STUDIO v2 — schema migration
--
-- Run this in the Supabase SQL editor BEFORE deploying the v2
-- frontend. The client sends `section`, `expires_at` and
-- `run_config` in every write; an apply_prompt_changes() that does
-- not know those columns drops them silently, which resets a
-- Workshop prompt to Library on every save. Migration first, always.
--
-- Idempotent: safe to run more than once.
--
-- Everything lives in the `prompts` schema of the shared project.
-- The same auth.users account signs in to Docket, Lists, Daily,
-- Hut and Prompts — this is another schema, not another login.
-- ============================================================

create schema if not exists prompts;

-- `anon` is revoked from the schema itself, not merely the tables,
-- so the publishable key can only be used to attempt a sign-in.
revoke all on schema prompts from anon;
grant usage on schema prompts to authenticated;


-- ------------------------------------------------------------
-- 1. prompt_items — v1 table, extended
-- ------------------------------------------------------------

-- section  : which of the four areas the prompt belongs to.
-- expires_at: epoch ms; only ever set on Scratch. NULL = no expiry.
-- run_config: per-meta-prompt model/effort overrides, Workshop only.
--
-- int8 epoch-ms is the existing convention on this table
-- (created_at / updated_at / deleted_at) — matched deliberately
-- rather than introducing a timestamptz alongside them.
alter table prompts.prompt_items
  add column if not exists section    text  not null default 'library',
  add column if not exists expires_at int8,
  add column if not exists run_config jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'prompt_items_section_chk'
      and conrelid = 'prompts.prompt_items'::regclass
  ) then
    alter table prompts.prompt_items
      add constraint prompt_items_section_chk
      check (section in ('library', 'workshop', 'scratch'));
  end if;
end $$;

-- The delta pull is `where user_id = ? and revision > ? order by revision`.
create index if not exists prompt_items_user_revision_idx
  on prompts.prompt_items (user_id, revision);

create index if not exists prompt_items_user_section_idx
  on prompts.prompt_items (user_id, section);

alter table prompts.prompt_items enable row level security;

drop policy if exists prompt_items_owner on prompts.prompt_items;
create policy prompt_items_owner on prompts.prompt_items
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on prompts.prompt_items to authenticated;


-- ------------------------------------------------------------
-- 2. prompt_runs — one row per API run
-- ------------------------------------------------------------

-- Append-only from the client's point of view: written once when a
-- run finishes (success OR failure), then only `keep` is toggled and
-- rows are deleted. No outbox and no revision cursor — you cannot
-- make an API call offline, so a run has nothing to queue. History
-- reads a plain created_at-ordered page and caches it for offline
-- viewing.
--
-- requested_model / served_model / response_id are the "receipt":
-- which model was ASKED FOR versus which one actually answered. A
-- provider can resolve a family alias to a dated snapshot, and the
-- record has to show that rather than repeat what was requested.
create table if not exists prompts.prompt_runs (
  user_id           uuid  not null references auth.users(id) on delete cascade,
  id                int8  not null,
  meta_prompt_id    int8,
  meta_prompt_title text  not null default '',
  provider          text  not null default 'anthropic',
  requested_model   text  not null default '',
  served_model      text  not null default '',
  response_id       text  not null default '',
  prompt_version    text  not null default '',
  input             text  not null default '',
  output            text  not null default '',
  status            text  not null default 'ok',
  error_message     text  not null default '',
  input_tokens      int4  not null default 0,
  output_tokens     int4  not null default 0,
  cost_usd          numeric(12, 6) not null default 0,
  duration_ms       int4  not null default 0,
  keep              bool  not null default false,
  saved_prompt_id   int8,
  created_at        int8  not null,
  primary key (user_id, id),
  constraint prompt_runs_status_chk check (status in ('ok', 'error'))
);

create index if not exists prompt_runs_user_created_idx
  on prompts.prompt_runs (user_id, created_at desc);

alter table prompts.prompt_runs enable row level security;

drop policy if exists prompt_runs_owner on prompts.prompt_runs;
create policy prompt_runs_owner on prompts.prompt_runs
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on prompts.prompt_runs to authenticated;


-- ------------------------------------------------------------
-- 3. user_settings — one jsonb row per user
-- ------------------------------------------------------------

-- Theme, default model, per-section retention. One row and one write,
-- so adding a preference later is not a schema change.
--
-- Provider API keys are deliberately NOT here. They stay in the
-- browser's localStorage and are never written to Supabase — same
-- rule as sc and lists. See settings.js for the reasoning.
create table if not exists prompts.user_settings (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  settings   jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table prompts.user_settings enable row level security;

drop policy if exists user_settings_owner on prompts.user_settings;
create policy user_settings_owner on prompts.user_settings
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

grant select, insert, update, delete on prompts.user_settings to authenticated;


-- ------------------------------------------------------------
-- 4. apply_prompt_changes — batched write with optimistic concurrency
-- ------------------------------------------------------------

-- CREATE OR REPLACE rather than a patch, so the function body is a
-- known quantity regardless of what shape the v1 version was in.
--
-- `revision` does double duty: a per-user monotonic counter that the
-- delta pull uses as a cursor, AND the optimistic-concurrency token
-- for a single row. The next value is derived from max(revision) for
-- this user under an advisory lock, so it continues from wherever v1
-- left off instead of resetting.
--
-- Raises PROMPT_VERSION_CONFLICT when a row moved underneath the
-- caller; the client force-pulls, rebases its outbox and retries.
create or replace function prompts.apply_prompt_changes(changes jsonb)
returns table (prompt_id int8, new_revision int8)
language plpgsql
security invoker
set search_path = prompts, public, pg_catalog
as $$
declare
  uid      uuid := auth.uid();
  change   jsonb;
  next_rev int8;
  cur_rev  int8;
  exp_rev  int8;
  pid      int8;
  is_del   boolean;
begin
  if uid is null then
    raise exception 'NOT_AUTHENTICATED';
  end if;

  if changes is null or jsonb_typeof(changes) <> 'array' then
    raise exception 'INVALID_CHANGES';
  end if;

  -- Serialises revision allocation for this user across concurrent
  -- devices. Released at end of transaction.
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 0));

  select coalesce(max(revision), 0) into next_rev
    from prompts.prompt_items
   where user_id = uid;

  for change in select * from jsonb_array_elements(changes)
  loop
    pid := (change->>'id')::int8;
    if pid is null then
      raise exception 'INVALID_CHANGE_ID';
    end if;

    exp_rev := coalesce((change->>'expected_revision')::int8, 0);
    is_del  := coalesce(change->>'action', 'upsert') = 'delete';

    select revision into cur_rev
      from prompts.prompt_items
     where user_id = uid and id = pid;

    -- A row we have never seen has cur_rev NULL; the client sends 0.
    if cur_rev is not null and cur_rev <> exp_rev then
      raise exception 'PROMPT_VERSION_CONFLICT';
    end if;

    next_rev := next_rev + 1;

    if is_del then
      -- Tombstone, not a hard delete: other devices learn about the
      -- removal by seeing the row come back with deleted_at set.
      insert into prompts.prompt_items as t (
        user_id, id, title, prompt_text, category, tags, notes, pinned,
        created_at, updated_at, sort_order, deleted_at, revision, changed_at,
        section, expires_at, run_config
      )
      values (
        uid, pid, '', '', '', '{}', '', false,
        coalesce((change->>'deleted_at')::int8, 0),
        coalesce((change->>'deleted_at')::int8, 0),
        0,
        coalesce((change->>'deleted_at')::int8, 0),
        next_rev, now(),
        'library', null, null
      )
      on conflict (user_id, id) do update set
        title       = '',
        prompt_text = '',
        category    = '',
        tags        = '{}',
        notes       = '',
        pinned      = false,
        updated_at  = excluded.deleted_at,
        deleted_at  = excluded.deleted_at,
        revision    = excluded.revision,
        changed_at  = now(),
        expires_at  = null,
        run_config  = null;
    else
      insert into prompts.prompt_items as t (
        user_id, id, title, prompt_text, category, tags, notes, pinned,
        created_at, updated_at, sort_order, deleted_at, revision, changed_at,
        section, expires_at, run_config
      )
      values (
        uid,
        pid,
        coalesce(change->>'title', ''),
        coalesce(change->>'text', ''),
        coalesce(change->>'category', ''),
        coalesce(
          (select array_agg(value::text)
             from jsonb_array_elements_text(
               case when jsonb_typeof(change->'tags') = 'array'
                    then change->'tags' else '[]'::jsonb end)),
          '{}'
        ),
        coalesce(change->>'notes', ''),
        coalesce((change->>'pinned')::boolean, false),
        coalesce((change->>'created_at')::int8, 0),
        coalesce((change->>'updated_at')::int8, 0),
        coalesce((change->>'sort_order')::float8, 0),
        null,
        next_rev,
        now(),
        coalesce(nullif(change->>'section', ''), 'library'),
        (change->>'expires_at')::int8,
        case when jsonb_typeof(change->'run_config') = 'object'
             then change->'run_config' else null end
      )
      on conflict (user_id, id) do update set
        title       = excluded.title,
        prompt_text = excluded.prompt_text,
        category    = excluded.category,
        tags        = excluded.tags,
        notes       = excluded.notes,
        pinned      = excluded.pinned,
        created_at  = excluded.created_at,
        updated_at  = excluded.updated_at,
        sort_order  = excluded.sort_order,
        deleted_at  = null,
        revision    = excluded.revision,
        changed_at  = now(),
        section     = excluded.section,
        expires_at  = excluded.expires_at,
        run_config  = excluded.run_config;
    end if;

    prompt_id    := pid;
    new_revision := next_rev;
    return next;
  end loop;
end;
$$;

revoke all on function prompts.apply_prompt_changes(jsonb) from public, anon;
grant execute on function prompts.apply_prompt_changes(jsonb) to authenticated;


-- ------------------------------------------------------------
-- 5. prompt_data — the dead v1 table
-- ------------------------------------------------------------
-- The whole-document jsonb store from the Gist era. The v1 client
-- referenced it zero times and v2 does not touch it. Confirm it is
-- empty, then drop it:
--
--   select count(*) from prompts.prompt_data;
--   drop table prompts.prompt_data;
--
-- Left in place by this migration on purpose — dropping a table is
-- not something a migration should do without you looking first.
