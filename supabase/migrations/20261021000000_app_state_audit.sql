-- Keep a recoverable snapshot for every app_state write. The application still uses its
-- compact JSON document, but updates are now auditable and can be restored if an import or
-- sync produces an unexpected result.

create table if not exists public.app_state_history (
  id                  bigint generated always as identity primary key,
  changed_at          timestamptz not null default now(),
  actor_type          text not null default 'unknown',
  actor_id            uuid,
  changed_fields      jsonb not null default '[]'::jsonb,
  -- Full snapshots are retained for user writes so they can be restored. Automated
  -- service syncs keep only their changed paths, avoiding a full-document copy every hour.
  before_data         jsonb,
  after_data          jsonb,
  base_updated_at     timestamptz,
  resulting_updated_at timestamptz
);

create index if not exists app_state_history_changed_at_idx
  on public.app_state_history (changed_at desc);

create or replace function public.jsonb_changed_paths(
  old_doc jsonb,
  new_doc jsonb,
  prefix text default ''
) returns jsonb
language plpgsql
immutable
as $$
declare
  result jsonb := '[]'::jsonb;
  key_name text;
  old_value jsonb;
  new_value jsonb;
  child jsonb;
  path text;
begin
  if jsonb_typeof(old_doc) = 'object' and jsonb_typeof(new_doc) = 'object' then
    for key_name in
      select key from (
        select jsonb_object_keys(old_doc) as key
        union
        select jsonb_object_keys(new_doc) as key
      ) keys
    loop
      old_value := old_doc -> key_name;
      new_value := new_doc -> key_name;
      path := case when prefix = '' then key_name else prefix || '.' || key_name end;
      if jsonb_typeof(old_value) = 'object' and jsonb_typeof(new_value) = 'object' then
        child := public.jsonb_changed_paths(old_value, new_value, path);
        result := result || child;
      elsif old_value is distinct from new_value then
        result := result || jsonb_build_array(path);
      end if;
    end loop;
  elsif old_doc is distinct from new_doc then
    result := result || jsonb_build_array(coalesce(nullif(prefix, ''), '$'));
  end if;
  return result;
end;
$$;

create or replace function public.record_app_state_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  role_name text := coalesce(current_setting('request.jwt.claim.role', true), 'unknown');
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

drop trigger if exists app_state_audit_update on public.app_state;
create trigger app_state_audit_update
  before update of data on public.app_state
  for each row execute function public.record_app_state_change();

alter table public.app_state_history enable row level security;
drop policy if exists "authenticated users can read app state history" on public.app_state_history;
create policy "authenticated users can read app state history"
  on public.app_state_history for select to authenticated using (true);
