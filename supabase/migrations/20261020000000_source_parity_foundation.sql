-- SOC5 Outbound v2: source-parity foundation. Disposable replay only.
-- Covers: full backlog date/time (lead 8), cluster import + backlog propagation
-- (lead 7), SeaTalk presence / round-robin routing / expiry (lead 2), approval
-- provisioning state (lead 1), auth + user administration (lead 6).

-- ------------------------------------------------------- 8. backlog date/time
-- requests.backlogs_timestamp was `date`, which silently dropped the time of day
-- carried by clusters.backlogs_timestamp. Existing dates are read as the start of
-- the Asia/Manila business day (the only zone the source ever used).
alter table requests
  alter column backlogs_timestamp type timestamptz
  using (backlogs_timestamp::timestamp at time zone 'Asia/Manila');

-- ----------------------------------------------------- 7. cluster import
-- The source upserts on cluster_name; dock_number may be absent for some hubs.
create unique index clusters_name_key on clusters (name);
alter table clusters alter column dock_no drop not null;

-- Validated bulk upsert. Rows come from the signed sync endpoint (TypeScript has
-- already rejected malformed rows); this keeps the write atomic and re-validates
-- the invariants that protect the table.
create or replace function import_clusters(p_rows jsonb, p_source text default 'google-apps-script')
returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  received integer := coalesce(jsonb_array_length(p_rows), 0);
  processed integer := 0;
begin
  with src as (
    -- duplicate names: the LAST row wins (source Edge Function behavior)
    select distinct on (btrim(e ->> 'name')) btrim(e ->> 'name') as name, btrim(e ->> 'region') as region,
           e ->> 'dock_no' as dock_no, coalesce(nullif(e ->> 'backlogs', '')::integer, 0) as backlogs,
           nullif(e ->> 'backlogs_timestamp', '')::timestamptz as backlogs_timestamp
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality as t(e, ord)
    where btrim(coalesce(e ->> 'name', '')) <> '' and btrim(coalesce(e ->> 'region', '')) <> ''
      and coalesce(nullif(e ->> 'backlogs', '')::integer, 0) >= 0
    order by btrim(e ->> 'name'), ord desc
  ), up as (
    insert into clusters (name, hub_name, region, dock_no, backlogs, backlogs_timestamp, active)
    select btrim(name), btrim(name), btrim(region), nullif(btrim(dock_no), ''), coalesce(backlogs, 0), backlogs_timestamp, true
    from src
    on conflict (name) do update set
      hub_name = excluded.hub_name, region = excluded.region, dock_no = excluded.dock_no,
      backlogs = excluded.backlogs, backlogs_timestamp = excluded.backlogs_timestamp, active = true
    returning 1
  )
  select count(*) into processed from up;
  insert into audit_events (event_type, subject_type, metadata)
  values ('CLUSTERS_IMPORTED', 'clusters', jsonb_build_object('source', p_source, 'received', received, 'processed', processed));
  return jsonb_build_object('received', received, 'processed', processed, 'rejected', received - processed);
end
$fn$;

-- Automatic backlog propagation to matching requests (source migration
-- 20260929000000). Differences from the source, both deliberate:
--  * every change is audited (immutable request_events row) and bumps row_version
--    so concurrent workflow commits retry instead of losing the update;
--  * terminal immutable rows (CANCELLED, FINAL_NO_ROUTE, LEGACY_UNRESOLVED) are
--    skipped because the terminal guard forbids mutating them.
create or replace function private.propagate_cluster_backlogs() returns trigger
language plpgsql security definer set search_path = public as $fn$
declare r record;
begin
  for r in
    select id, status, approval_status, approval_version, backlogs, backlogs_timestamp
    from requests
    where (cluster_id = new.id or cluster = new.name)
      and (backlogs is distinct from new.backlogs or backlogs_timestamp is distinct from new.backlogs_timestamp)
      and status <> 'CANCELLED'
      and rejection_disposition is distinct from 'FINAL_NO_ROUTE'
      and rejection_disposition is distinct from 'LEGACY_UNRESOLVED'
    for update
  loop
    update requests
       set backlogs = new.backlogs, backlogs_timestamp = new.backlogs_timestamp,
           row_version = row_version + 1, updated_at = now()
     where id = r.id;
    insert into request_events (request_id, event_type, from_status, to_status, from_approval_status,
      to_approval_status, approval_version, metadata)
    values (r.id, 'BACKLOG_PROPAGATED', r.status::text, r.status::text, r.approval_status, r.approval_status,
      r.approval_version,
      jsonb_build_object('source', 'cluster_import', 'clusterId', new.id, 'changes', jsonb_build_object(
        'backlogs', jsonb_build_object('before', r.backlogs, 'after', new.backlogs),
        'backlogsTimestamp', jsonb_build_object('before', r.backlogs_timestamp, 'after', new.backlogs_timestamp))));
  end loop;
  return null;
end
$fn$;
create trigger clusters_propagate_backlogs
  after insert or update of name, backlogs, backlogs_timestamp on clusters
  for each row execute function private.propagate_cluster_backlogs();

-- ------------------------------------- 1/2. SeaTalk assignments, routing, expiry
alter table workflow_outbox drop constraint workflow_outbox_channel_check;
alter table workflow_outbox add constraint workflow_outbox_channel_check
  check (channel in ('SEATALK_ALERT', 'SEATALK_APPROVAL_SYNC', 'SEATALK_APPROVAL_PROVISION', 'GOOGLE_SHEETS'));

alter table seatalk_approval_assignments drop constraint seatalk_approval_assignments_status_check;
alter table seatalk_approval_assignments add constraint seatalk_approval_assignments_status_check
  check (status in ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CLOSED', 'FAILED'));
alter table seatalk_approval_assignments
  add column seatalk_employee_code text,
  add column delivered_at timestamptz,          -- provider acknowledged item creation (NOT-3)
  add column failure_reason text,
  add column updated_at timestamptz not null default now();
create index seatalk_assignments_expiry_idx on seatalk_approval_assignments (expires_at) where status = 'PENDING';
create index seatalk_assignments_cycle_idx on seatalk_approval_assignments (request_id, routing_cycle, status);

-- Presence + round-robin selection + assignment, atomically. The token hash and
-- item id are computed by the caller (the HMAC secret never enters the database).
-- Result codes: ASSIGNED | ALREADY_ASSIGNED | NO_CANDIDATE | TERMINAL | NOT_FOUND.
create or replace function assign_next_approver(
  p_request uuid, p_assignment_id uuid, p_item_id text, p_token_hash text, p_now timestamptz default now()
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  req requests;
  fresh integer := coalesce((select (value #>> '{}')::integer from app_settings where key = 'presence_freshness_seconds'), 60);
  expiry integer := coalesce((select (value #>> '{}')::integer from app_settings where key = 'assignment_expiry_seconds'), 180);
  cycle integer;
  open_a seatalk_approval_assignments;
  chosen profiles;
  cur uuid;
  present_count integer;
  eligible_count integer;
begin
  select * into req from requests where id = p_request for update;
  if not found then return jsonb_build_object('result', 'NOT_FOUND'); end if;
  if req.status not in ('PENDING', 'REROUTED') or req.approval_status <> 'PENDING' then
    return jsonb_build_object('result', 'TERMINAL');
  end if;

  select * into open_a from seatalk_approval_assignments where request_id = p_request and status = 'PENDING' for update;
  if found then
    return jsonb_build_object('result', 'ALREADY_ASSIGNED', 'assignmentId', open_a.id, 'assigneeId', open_a.assignee_id,
      'employeeCode', open_a.seatalk_employee_code, 'itemId', open_a.provider_item_id,
      'expiresAt', open_a.expires_at, 'delivered', open_a.delivered_at is not null);
  end if;

  select coalesce(max(routing_cycle), 1) into cycle from seatalk_approval_assignments where request_id = p_request;

  -- Present approvers: active fte_ops with a SeaTalk identity and a fresh heartbeat (SEA-6).
  select count(*) into present_count from profiles p
    where p.role = 'fte_ops' and p.account_status = 'ACTIVE' and p.seatalk_employee_code is not null
      and p.last_seen_at >= p_now - make_interval(secs => fresh);
  if present_count = 0 then return jsonb_build_object('result', 'NO_CANDIDATE'); end if;

  -- Approvers who already expired/failed in this cycle are skipped until everyone had a turn.
  select count(*) into eligible_count from profiles p
    where p.role = 'fte_ops' and p.account_status = 'ACTIVE' and p.seatalk_employee_code is not null
      and p.last_seen_at >= p_now - make_interval(secs => fresh)
      and not exists (select 1 from seatalk_approval_assignments a where a.request_id = p_request
        and a.routing_cycle = cycle and a.assignee_id = p.id and a.status in ('EXPIRED', 'FAILED'));
  if eligible_count = 0 then cycle := cycle + 1; end if;

  -- Round robin: next eligible id after the global cursor, wrapping to the first.
  select last_profile_id into cur from approval_routing_cursors where scope = 'fte_ops' for update;
  for pass in 1..2 loop
    select p.* into chosen from profiles p
      where p.role = 'fte_ops' and p.account_status = 'ACTIVE' and p.seatalk_employee_code is not null
        and p.last_seen_at >= p_now - make_interval(secs => fresh)
        and not exists (select 1 from seatalk_approval_assignments a where a.request_id = p_request
          and a.routing_cycle = cycle and a.assignee_id = p.id and a.status in ('EXPIRED', 'FAILED'))
        and (pass = 2 or cur is null or p.id > cur)
      order by p.id limit 1;
    exit when found;
  end loop;
  if chosen.id is null then return jsonb_build_object('result', 'NO_CANDIDATE'); end if;

  insert into approval_routing_cursors (scope, last_profile_id, updated_at) values ('fte_ops', chosen.id, p_now)
    on conflict (scope) do update set last_profile_id = excluded.last_profile_id, updated_at = excluded.updated_at;

  insert into seatalk_approval_assignments (id, request_id, assignee_id, status, provider_item_id, token_hash,
      sent_at, expires_at, routing_cycle, correlation_id, seatalk_employee_code, created_at, updated_at)
    values (p_assignment_id, p_request, chosen.id, 'PENDING', p_item_id, p_token_hash,
      p_now, p_now + make_interval(secs => expiry), cycle, req.approval_correlation_id, chosen.seatalk_employee_code, p_now, p_now);

  return jsonb_build_object('result', 'ASSIGNED', 'assignmentId', p_assignment_id, 'assigneeId', chosen.id,
    'employeeCode', chosen.seatalk_employee_code, 'itemId', p_item_id,
    'expiresAt', p_now + make_interval(secs => expiry), 'delivered', false);
end
$fn$;

-- Expire overdue assignments; returns the request ids that need re-routing.
create or replace function expire_assignments(p_now timestamptz default now()) returns jsonb
language sql security definer set search_path = public as $fn$
  with x as (
    update seatalk_approval_assignments
       set status = 'EXPIRED', responded_at = p_now, updated_at = p_now
     where status = 'PENDING' and expires_at <= p_now
     returning request_id)
  select coalesce(jsonb_agg(distinct request_id), '[]'::jsonb) from x
$fn$;

-- Requests that wait for approval but hold no open assignment (nobody was present
-- earlier, or delivery failed). Only when at least one approver is present, and not
-- again within p_retry_seconds of a failed delivery.
create or replace function orphan_approval_requests(p_now timestamptz default now(), p_limit integer default 100,
  p_retry_seconds integer default 300) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  fresh integer := coalesce((select (value #>> '{}')::integer from app_settings where key = 'presence_freshness_seconds'), 60);
begin
  if not exists (select 1 from profiles p where p.role = 'fte_ops' and p.account_status = 'ACTIVE'
      and p.seatalk_employee_code is not null and p.last_seen_at >= p_now - make_interval(secs => fresh)) then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(id) from (
      select r.id from requests r
      where r.status in ('PENDING', 'REROUTED') and r.approval_status = 'PENDING'
        and not exists (select 1 from seatalk_approval_assignments a where a.request_id = r.id and a.status = 'PENDING')
        and not exists (select 1 from seatalk_approval_assignments a where a.request_id = r.id and a.status = 'FAILED'
                         and a.updated_at > p_now - make_interval(secs => p_retry_seconds))
      order by r.id limit p_limit) q), '[]'::jsonb);
end
$fn$;

-- Any decision / cancellation closes the request's other open assignments, so late
-- callbacks can never apply (web-wins, SEA-5).
create or replace function private.close_open_assignments() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if new.status not in ('PENDING', 'REROUTED') and old.status in ('PENDING', 'REROUTED') then
    update seatalk_approval_assignments
       set status = 'CLOSED', updated_at = now(), failure_reason = coalesce(failure_reason, 'request_' || lower(new.status::text))
     where request_id = new.id and status = 'PENDING';
  end if;
  return new;
end
$fn$;
create trigger requests_close_assignments after update of status on requests
  for each row execute function private.close_open_assignments();

-- ------------------------------------------------------ 6. auth + user admin
alter table profiles
  add column must_change_password boolean not null default false,
  add column password_reset_at timestamptz,
  add column password_changed_at timestamptz;
create unique index profiles_ops_id_key on profiles (lower(ops_id)) where ops_id is not null;

insert into app_settings (key, value) values ('allowed_email_domains', '["spxexpress.com"]')
  on conflict (key) do nothing;

-- SEA-7: every non-backroom sign-up (Google OAuth, email OTP, SeaTalk) becomes a
-- PENDING_APPROVAL profile with NO operational access; an administrator approves and
-- assigns a role. The email domain is enforced here as well as in the API. SeaTalk
-- identity comes only from raw_app_meta_data (server-written); user_metadata is
-- client-writable and is never trusted for privileges.
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
  if mail = '' or position('@' in mail) = 0
     or not (allowed ? split_part(mail, '@', 2)) then
    raise exception 'EMAIL_DOMAIN_NOT_ALLOWED' using errcode = 'P0001';
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
    execute 'create trigger on_auth_user_created after insert on auth.users
             for each row execute function private.handle_new_auth_user()';
  end if;
end
$do$;

-- Backroom (Ops ID) users. The auth user is created first by the API (admin API);
-- this writes the profile + immutable audit atomically. Duplicate Ops IDs fail.
create or replace function admin_create_backroom_user(p_id uuid, p_name text, p_ops_id text, p_role user_role, p_actor uuid)
returns jsonb
language plpgsql security definer set search_path = public as $fn$
begin
  if p_role not in ('ops_pic', 'doc_officer') then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED');
  end if;
  if exists (select 1 from profiles where lower(ops_id) = lower(p_ops_id)) then
    return jsonb_build_object('ok', false, 'code', 'OPS_ID_TAKEN');
  end if;
  insert into profiles (id, role, full_name, email, ops_id, account_status, must_change_password, password_reset_at)
  values (p_id, p_role, btrim(p_name), lower(p_ops_id) || '@backroom.soc5.internal', lower(p_ops_id), 'ACTIVE', true, now());
  insert into audit_events (event_type, actor_id, subject_type, subject_id, metadata)
  values ('USER_CREATED', p_actor, 'profile', p_id::text, jsonb_build_object('name', btrim(p_name), 'ops_id', lower(p_ops_id), 'role', p_role));
  return jsonb_build_object('ok', true);
end
$fn$;

create or replace function admin_update_user(p_user uuid, p_name text, p_role user_role, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $fn$
begin
  if p_user = p_actor then return jsonb_build_object('ok', false, 'code', 'SELF_CHANGE'); end if;
  update profiles set full_name = btrim(p_name), role = p_role, updated_at = now()
   where id = p_user and account_status <> 'PENDING_APPROVAL';
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  insert into audit_events (event_type, actor_id, subject_type, subject_id, metadata)
  values ('USER_UPDATED', p_actor, 'profile', p_user::text, jsonb_build_object('name', btrim(p_name), 'role', p_role));
  return jsonb_build_object('ok', true);
end
$fn$;

-- Password reset marks the account; the API then sets the new password through the
-- auth admin API. Only active backroom accounts (Ops ID) can be reset.
create or replace function admin_mark_password_reset(p_user uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $fn$
begin
  update profiles set must_change_password = true, password_reset_at = now(), password_changed_at = null, updated_at = now()
   where id = p_user and ops_id is not null and account_status = 'ACTIVE';
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  insert into audit_events (event_type, actor_id, subject_type, subject_id)
  values ('PASSWORD_RESET', p_actor, 'profile', p_user::text);
  return jsonb_build_object('ok', true);
end
$fn$;

create or replace function mark_password_changed(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public as $fn$
begin
  update profiles set must_change_password = false, password_changed_at = now(), updated_at = now()
   where id = p_user and must_change_password = true;
  if not found then return jsonb_build_object('ok', false, 'code', 'INVALID_STATE'); end if;
  insert into audit_events (event_type, actor_id, subject_type, subject_id)
  values ('PASSWORD_CHANGED', p_user, 'profile', p_user::text);
  return jsonb_build_object('ok', true);
end
$fn$;

-- Unauthenticated "please create my Backroom account" request. Deduplicated per
-- Ops ID per day; routed to FTE Ops and FTE MM as role notifications (source behavior).
create or replace function submit_access_request(p_name text, p_ops_id text) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  ops text := lower(btrim(p_ops_id));
  day text := to_char(now() at time zone 'Asia/Manila', 'YYYYMMDD');
begin
  if ops !~ '^ops[0-9]+$' or char_length(btrim(p_name)) not between 2 and 120 then
    return jsonb_build_object('ok', false, 'code', 'VALIDATION_FAILED');
  end if;
  insert into notifications (dedupe_key, event_type, title, body, recipient_role)
  select 'access:' || ops || ':' || day || ':' || r, 'BACKROOM_ACCESS_REQUESTED', 'Backroom access requested',
         btrim(p_name) || ' requested Backroom access with Ops ID ' || ops || '. Create the account from User Management after verification.',
         r::user_role
  from unnest(array['fte_ops', 'fte_mm']) as r
  on conflict (dedupe_key) do nothing;
  return jsonb_build_object('ok', true);
end
$fn$;

-- ----------------------------------------------------------------- grants
-- New functions default to PUBLIC execute; keep them server-side only.
revoke execute on function import_clusters, assign_next_approver, expire_assignments, orphan_approval_requests,
  admin_create_backroom_user, admin_update_user, admin_mark_password_reset, mark_password_changed,
  submit_access_request from public, anon, authenticated;
grant execute on function import_clusters, assign_next_approver, expire_assignments, orphan_approval_requests,
  admin_create_backroom_user, admin_update_user, admin_mark_password_reset, mark_password_changed,
  submit_access_request to service_role;
grant all on all tables in schema public to service_role;
