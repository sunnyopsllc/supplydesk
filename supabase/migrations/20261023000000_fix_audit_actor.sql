-- The audit trigger read the legacy request.jwt.claim.role setting, which current PostgREST no
-- longer sets, so every entry was recorded as 'unknown' and automated syncs kept full copies of the
-- data. Read the role from the request.jwt.claims JSON instead (falling back to the legacy setting),
-- so syncs record only their changed paths and user edits keep restorable snapshots.

create or replace function public.record_app_state_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  claims_text text := current_setting('request.jwt.claims', true);
  role_name text := coalesce(
    nullif(case when claims_text is null or claims_text = '' then null else (claims_text::jsonb ->> 'role') end, ''),
    nullif(current_setting('request.jwt.claim.role', true), ''),
    'unknown'
  );
  actor text := case when role_name = 'service_role' then 'service' when role_name = 'authenticated' then 'user' else role_name end;
begin
  if new.data is not distinct from old.data then
    return new;
  end if;

  insert into public.app_state_history (
    actor_type, actor_id, changed_fields, before_data, after_data,
    base_updated_at, resulting_updated_at
  ) values (
    actor,
    auth.uid(),
    public.jsonb_changed_paths(old.data, new.data),
    case when actor = 'service' then null else old.data end,
    case when actor = 'service' then null else new.data end,
    old.updated_at,
    new.updated_at
  );
  return new;
end;
$$;
