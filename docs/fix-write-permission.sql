-- ============================================================
-- FIX: "permission denied for table prompt_items"
--
-- Run this on its own. It replaces apply_prompt_changes() and
-- nothing else — no table, column, policy or grant is touched.
--
-- WHAT WENT WRONG
--   The v2 migration recreated this function as SECURITY INVOKER.
--   The v1 function was SECURITY DEFINER. Every prompt write in the
--   app goes through this one function, so under INVOKER it began
--   running as the authenticated role, which holds SELECT on that table
--   but not INSERT or UPDATE. Reads kept working, which is why the
--   library still listed 25 prompts, and every save failed.
--
-- WHY DEFINER IS THE RIGHT FIX HERE, NOT A NEW GRANT
--   Granting INSERT/UPDATE on prompt_items to authenticated would
--   also work, but it widens direct table access for every client
--   and leans entirely on the RLS policy to contain it. This
--   function already derives the owner itself — uid comes from
--   auth.uid(), it raises if that is null, every statement is scoped
--   to user_id = uid, and no client-supplied user_id is ever read —
--   so DEFINER restores exactly the v1 behaviour without handing the
--   browser any new privilege on the table.
--
-- Idempotent. Safe to run more than once.
-- ============================================================

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

-- CREATE OR REPLACE only replaces a function with the SAME argument
-- types. If the live one takes anything other than a single `jsonb`
-- (a `jsonb[]`, say), the statement below would add a second overload
-- beside it rather than replacing it, and PostgREST would then have
-- two candidates for one RPC name — an ambiguity error at best, the
-- wrong function at worst. Drop every overload of this one name
-- first, so what follows is the only definition.
--
-- To see what is there before running this:
--   select oid::regprocedure from pg_proc
--    where pronamespace = 'prompts'::regnamespace
--      and proname = 'apply_prompt_changes';
do $$
declare
  signature text;
begin
  for signature in
    select oid::regprocedure::text from pg_proc
     where pronamespace = 'prompts'::regnamespace
       and proname = 'apply_prompt_changes'
  loop
    execute 'drop function ' || signature;
    raise notice 'Dropped previous overload: %', signature;
  end loop;
end $$;

create or replace function prompts.apply_prompt_changes(changes jsonb)
returns table (prompt_id int8, new_revision int8)
language plpgsql
-- SECURITY DEFINER, as the v1 function was. The client never writes
-- prompt_items directly — every write goes through this one function —
-- so under INVOKER it ran as `authenticated`, which holds SELECT but
-- not INSERT/UPDATE on the table, and every save failed with
-- "permission denied for table prompt_items".
--
-- DEFINER is safe here because the function derives the owner itself:
-- uid comes from auth.uid(), it raises if that is null, every statement
-- is scoped to user_id = uid, and no client-supplied user_id is ever
-- read. search_path is pinned so a DEFINER function cannot be steered
-- at objects in another schema.
security definer
set search_path = prompts, pg_catalog
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
