-- SOC5 Outbound v2: fixes from the independent review of 20261020000000..300. Disposable replay only.

-- (1) Privilege escalation: FTE Ops/MM may manage only Ops ID (backroom) accounts between ops_pic and doc_officer.
-- Changing anyone else, or granting an FTE role, needs an administrator. No self change. Audit stays immutable.
create or replace function admin_update_user(p_user uuid, p_name text, p_role user_role, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  actor profiles;
  target profiles;
begin
  if p_user = p_actor then return jsonb_build_object('ok', false, 'code', 'SELF_CHANGE'); end if;
  select * into actor from profiles where id = p_actor and account_status = 'ACTIVE';
  if not found then return jsonb_build_object('ok', false, 'code', 'FORBIDDEN'); end if;
  select * into target from profiles where id = p_user and account_status <> 'PENDING_APPROVAL' for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if not actor.is_admin then
    if actor.role not in ('fte_ops', 'fte_mm')
       or target.ops_id is null or target.is_admin
       or target.role not in ('ops_pic', 'doc_officer') or p_role not in ('ops_pic', 'doc_officer') then
      return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
    end if;
  end if;
  update profiles set full_name = btrim(p_name), role = p_role, updated_at = now() where id = p_user;
  insert into audit_events (event_type, actor_id, subject_type, subject_id, metadata)
  values ('USER_UPDATED', p_actor, 'profile', p_user::text,
    jsonb_build_object('name', btrim(p_name), 'role', p_role, 'priorRole', target.role, 'byAdmin', actor.is_admin));
  return jsonb_build_object('ok', true);
end
$fn$;

-- (3) Pre-registration takeover: a profile exists only for a CONFIRMED email (OTP/Google/SeaTalk confirm it; a bare
-- password sign-up for someone else's address stays unconfirmed and gets no profile). The domain check still runs on
-- insert so foreign domains are refused immediately.
create or replace function private.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare
  app jsonb := coalesce(new.raw_app_meta_data, '{}'::jsonb);
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  mail text := lower(btrim(coalesce(new.email, '')));
  allowed jsonb := coalesce((select value from app_settings where key = 'allowed_email_domains'), '[]'::jsonb);
begin
  if app ->> 'account_type' = 'backroom' then
    return new;  -- backroom profiles are created by admin_create_backroom_user()
  end if;
  if mail = '' or position('@' in mail) = 0 or not (allowed ? split_part(mail, '@', 2)) then
    raise exception 'EMAIL_DOMAIN_NOT_ALLOWED' using errcode = 'P0001';
  end if;
  if new.email_confirmed_at is null then
    return new;  -- created later, when the address is confirmed
  end if;
  insert into profiles (id, role, full_name, email, seatalk_employee_code, account_status)
  values (new.id, null, coalesce(nullif(meta ->> 'full_name', ''), nullif(meta ->> 'name', ''), ''), mail,
          nullif(app ->> 'seatalk_employee_code', ''), 'PENDING_APPROVAL')
  on conflict (id) do nothing;
  return new;
end
$fn$;
do $do$
begin
  if to_regclass('auth.users') is not null then
    execute 'drop trigger if exists on_auth_user_created on auth.users';
    execute 'create trigger on_auth_user_created after insert or update of email_confirmed_at on auth.users
             for each row execute function private.handle_new_auth_user()';
  end if;
end
$do$;

-- (6) Notification paging: composite (created_at, id) cursor so rows sharing a timestamp are never skipped.
drop function if exists notification_feed(uuid, user_role, integer, timestamptz);
create or replace function notification_feed(p_user uuid, p_role user_role, p_limit integer default 50,
  p_before timestamptz default null, p_before_id uuid default null)
returns table (id uuid, event_type text, title text, body text, request_id uuid, created_at timestamptz, read boolean)
language sql stable security definer set search_path = public as $fn$
  select n.id, n.event_type, n.title, n.body, n.request_id, n.created_at, (r.notification_id is not null) as read
  from notifications n
  left join notification_reads r on r.notification_id = n.id and r.user_id = p_user
  where (n.recipient_user_id = p_user or n.recipient_role = p_role)
    and (p_before is null
         or (n.created_at, n.id) < (p_before, coalesce(p_before_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)))
  order by n.created_at desc, n.id desc
  limit least(greatest(p_limit, 1), 100)
$fn$;
revoke execute on function notification_feed(uuid, user_role, integer, timestamptz, uuid) from public, anon, authenticated;
grant execute on function notification_feed(uuid, user_role, integer, timestamptz, uuid) to service_role;

-- (10) A cluster an administrator deactivated stays inactive across imports (the source never touched `active`).
create or replace function import_clusters(p_rows jsonb, p_source text default 'google-apps-script')
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  received integer := coalesce(jsonb_array_length(p_rows), 0);
  processed integer := 0;
begin
  with src as (
    select distinct on (btrim(e ->> 'name')) btrim(e ->> 'name') as name, btrim(e ->> 'region') as region,
           e ->> 'dock_no' as dock_no, coalesce(nullif(e ->> 'backlogs', '')::integer, 0) as backlogs,
           nullif(e ->> 'backlogs_timestamp', '')::timestamptz as backlogs_timestamp
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as t(e, ord)
    where btrim(coalesce(e ->> 'name', '')) <> '' and btrim(coalesce(e ->> 'region', '')) <> ''
      and coalesce(nullif(e ->> 'backlogs', '')::integer, 0) >= 0
    order by btrim(e ->> 'name'), ord desc
  ), up as (
    insert into clusters (name, hub_name, region, dock_no, backlogs, backlogs_timestamp, active)
    select name, name, region, nullif(btrim(dock_no), ''), backlogs, backlogs_timestamp, true from src
    on conflict (name) do update set
      hub_name = excluded.hub_name, region = excluded.region, dock_no = excluded.dock_no,
      backlogs = excluded.backlogs, backlogs_timestamp = excluded.backlogs_timestamp
    returning 1
  )
  select count(*) into processed from up;
  insert into audit_events (event_type, subject_type, metadata)
  values ('CLUSTERS_IMPORTED', 'clusters', jsonb_build_object('source', p_source, 'received', received, 'processed', processed));
  return jsonb_build_object('received', received, 'processed', processed, 'rejected', received - processed);
end
$fn$;
revoke execute on function import_clusters from public, anon, authenticated;
grant execute on function import_clusters to service_role;

-- (11) Seed the round-robin cursor so its FOR UPDATE lock exists from the first routing call.
insert into approval_routing_cursors (scope, last_profile_id) values ('fte_ops', null) on conflict (scope) do nothing;
