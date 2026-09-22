-- Run in Supabase SQL editor before deploying the recovery frontend.
-- Separate from run receipts: drafts survive history retention and failed runs.
begin;
create table if not exists prompts.workshop_sessions (
  user_id uuid not null references auth.users(id) on delete cascade,
  id uuid not null,
  token uuid not null,
  snapshot jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
alter table prompts.workshop_sessions enable row level security;
drop policy if exists workshop_sessions_owner on prompts.workshop_sessions;
create policy workshop_sessions_owner on prompts.workshop_sessions
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
revoke all on prompts.workshop_sessions from anon;
grant select, insert, update on prompts.workshop_sessions to authenticated;

-- Atomic optimistic concurrency; token also makes retries after a lost response
-- idempotent. Clients cannot overwrite a version they have never read.
create or replace function prompts.save_workshop_session(
  p_id uuid, p_base uuid, p_token uuid, p_snapshot jsonb
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare affected integer;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_base is null then
    insert into prompts.workshop_sessions(user_id, id, token, snapshot)
      values (auth.uid(), p_id, p_token, p_snapshot)
      on conflict do nothing;
    get diagnostics affected = row_count;
    if affected = 1 then return true; end if;
  else
    update prompts.workshop_sessions set token = p_token, snapshot = p_snapshot, updated_at = now()
      where user_id = auth.uid() and id = p_id and token = p_base;
    get diagnostics affected = row_count;
    if affected = 1 then return true; end if;
  end if;
  return exists (select 1 from prompts.workshop_sessions
    where user_id = auth.uid() and id = p_id and token = p_token);
end;
$$;
revoke all on function prompts.save_workshop_session(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function prompts.save_workshop_session(uuid, uuid, uuid, jsonb) to authenticated;
commit;
