-- SOC5 Outbound v2: transactional workflow functions, queue, KPI, worker, admin.
-- Workflow changes (request row + event + notification/outbox intent +
-- idempotency record) commit atomically through commit_transition().
-- Domain decisions are computed server-side in TypeScript; the database
-- enforces optimistic versioning, CHECK constraints and append-only audit.

-- ------------------------------------------------------------------ guards
create or replace function request_events_block_truncate() returns trigger
language plpgsql as $fn$
begin
  raise exception 'request_events is append-only';
end
$fn$;
create trigger request_events_no_truncate
  before truncate on request_events
  for each statement execute function request_events_block_truncate();
create trigger audit_events_no_truncate
  before truncate on audit_events
  for each statement execute function request_events_block_truncate();

-- ---------------------------------------------------------- commit_transition
create or replace function commit_transition(
  p_request jsonb,
  p_expected_version integer,   -- null => create
  p_event jsonb,
  p_notifications jsonb default '[]'::jsonb,
  p_outbox jsonb default '[]'::jsonb,
  p_idem jsonb default null
) returns jsonb
language plpgsql security invoker set search_path = public as $fn$
declare
  n requests;
  cur requests;
  result requests;
begin
  n := jsonb_populate_record(null::requests, p_request);

  if p_expected_version is null then
    insert into requests select (n).*;
    select * into result from requests where id = n.id;
  else
    select * into cur from requests where id = n.id for update;
    if not found then
      return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
    end if;
    if cur.row_version <> p_expected_version then
      return jsonb_build_object('ok', false, 'code', 'VERSION_CONFLICT');
    end if;
    update requests set
      cluster_id = n.cluster_id, cluster = n.cluster, region = n.region, dock_no = n.dock_no,
      backlogs = n.backlogs, backlogs_timestamp = n.backlogs_timestamp,
      truck_size = n.truck_size, truck_type = n.truck_type,
      status = n.status, approval_status = n.approval_status, approval_version = n.approval_version,
      approval_correlation_id = n.approval_correlation_id, approval_source = n.approval_source,
      submitted_at = n.submitted_at,
      approved_at = n.approved_at, approved_by = n.approved_by,
      rejection_disposition = n.rejection_disposition, rejection_return_role = n.rejection_return_role,
      rejection_remarks = n.rejection_remarks, rejected_at = n.rejected_at, rejected_by = n.rejected_by,
      cancellation_remarks = n.cancellation_remarks, cancelled_at = n.cancelled_at, cancelled_by = n.cancelled_by,
      plate_number = n.plate_number, provide_time = n.provide_time, truck_assigned_by = n.truck_assigned_by,
      driver_id = n.driver_id, driver_assigned_at = n.driver_assigned_at, driver_assigned_by = n.driver_assigned_by,
      linehaul_trip_no = n.linehaul_trip_no, linehaul_trip_at = n.linehaul_trip_at, docked_at = n.docked_at,
      row_version = cur.row_version + 1, updated_at = now()
    where id = n.id
    returning * into result;
  end if;

  insert into request_events (request_id, event_type, actor_id, creator_id, from_status, to_status,
    from_approval_status, to_approval_status, approval_version, metadata, correlation_id, created_at)
  values (
    n.id, p_event->>'event_type', nullif(p_event->>'actor_id', '')::uuid, nullif(p_event->>'creator_id', '')::uuid,
    p_event->>'from_status', p_event->>'to_status', p_event->>'from_approval_status', p_event->>'to_approval_status',
    nullif(p_event->>'approval_version', '')::integer, coalesce(p_event->'metadata', '{}'::jsonb),
    nullif(p_event->>'correlation_id', '')::uuid, coalesce(nullif(p_event->>'created_at', '')::timestamptz, now())
  );

  insert into notifications (dedupe_key, request_id, event_type, title, body, recipient_user_id, recipient_role)
  select x.dedupe_key, n.id, x.event_type, x.title, coalesce(x.body, ''), x.recipient_user_id, x.recipient_role
  from jsonb_to_recordset(coalesce(p_notifications, '[]'::jsonb)) as x(
    dedupe_key text, event_type text, title text, body text, recipient_user_id uuid, recipient_role user_role)
  on conflict (dedupe_key) do nothing;

  insert into workflow_outbox (idempotency_key, channel, event_type, aggregate_id, payload)
  select x.idempotency_key, x.channel, x.event_type, n.id, coalesce(x.payload, '{}'::jsonb)
  from jsonb_to_recordset(coalesce(p_outbox, '[]'::jsonb)) as x(
    idempotency_key text, channel text, event_type text, payload jsonb)
  on conflict (idempotency_key) do nothing;

  if p_idem is not null then
    insert into idempotency_keys (actor_id, method, path, key, payload_hash, response_status, response_body)
    values ((p_idem->>'actor_id')::uuid, p_idem->>'method', p_idem->>'path', p_idem->>'key',
            p_idem->>'payload_hash', (p_idem->>'response_status')::integer, p_idem->'response_body');
  end if;

  return jsonb_build_object('ok', true, 'request', to_jsonb(result));
end
$fn$;

-- ------------------------------------------------------------ actionable queue
-- OPS-1: keyset pagination over (created_at desc, id desc); caller enforces
-- page-size options 25/50/100. Predicate mirrors domain isActionableForRole().
create or replace function queue_requests(
  p_user uuid, p_role user_role, p_limit integer,
  p_cursor_ts timestamptz default null, p_cursor_id uuid default null
) returns setof requests
language sql stable security invoker set search_path = public as $$
  select r.* from requests r
  where (
      (p_role = 'fte_ops' and (
          r.status in ('PENDING', 'REROUTED')
          or (r.status = 'REJECTED' and r.rejection_disposition = 'RETURN_TO_FTE_OPS')))
      or (p_role = 'fte_mm' and r.status = 'REQUESTED')
      or (p_role = 'doc_officer' and r.status = 'DOCKING' and r.driver_id is null)
      or (p_role = 'ops_pic' and r.created_by = p_user and (
          (r.status = 'REJECTED' and r.rejection_disposition = 'RETURN_TO_OPS_PIC')
          or (r.status = 'DOCKING' and r.driver_id is not null)))
    )
    and (p_cursor_ts is null or (r.created_at, r.id) < (p_cursor_ts, p_cursor_id))
  order by r.created_at desc, r.id desc
  limit least(greatest(p_limit, 1), 101)  -- 100 max page + 1 look-ahead row
$$;

-- --------------------------------------------------------------------- KPI
-- KPI-6: callable by browsers only with the reporting permission; service_role
-- (auth.uid() is null) is authorized by the API layer before calling.
create or replace function private.kpi_allowed() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is null or private.has_reporting()
$$;

create or replace function private.schedule_at(p_date date) returns reporting_schedules
language sql stable security definer set search_path = public as $$
  select s.* from reporting_schedules s where s.effective_from <= p_date order by s.effective_from desc limit 1
$$;

create or replace function kpi_summary(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  tz text := (private.schedule_at(p_to)).timezone;
  res jsonb;
begin
  if not private.kpi_allowed() then raise exception 'reporting permission required' using errcode = '42501'; end if;
  select jsonb_build_object(
    'total', count(*),
    'confirmed', count(*) filter (where status = 'DOCKED'),                  -- KPI-1
    'cancelled', count(*) filter (where status = 'CANCELLED'),
    -- KPI-2 Option B: final approval minus LATEST submission.
    'averageApprovalMinutes', round((avg(extract(epoch from (approved_at - submitted_at)) / 60)
        filter (where approved_at is not null))::numeric, 2),
    -- KPI-3 original formulas.
    'averageWaitingMinutes', round((avg(extract(epoch from (provide_time - request_timestamp)) / 60)
        filter (where provide_time is not null))::numeric, 2),
    'averageDwellMinutes', round((avg(extract(epoch from (linehaul_trip_at - request_timestamp)) / 60)
        filter (where linehaul_trip_at is not null))::numeric, 2)
  ) into res
  from requests
  where (request_timestamp at time zone tz)::date between p_from and p_to;
  return res;
end
$fn$;

create or replace function kpi_daily(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  tz text := (private.schedule_at(p_to)).timezone;
begin
  if not private.kpi_allowed() then raise exception 'reporting permission required' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('date', d, 'total', t, 'confirmed', c) order by d)
    from (
      select (request_timestamp at time zone tz)::date as d, count(*) as t,
             count(*) filter (where status = 'DOCKED') as c
      from requests
      where (request_timestamp at time zone tz)::date between p_from and p_to
      group by 1
    ) q), '[]'::jsonb);
end
$fn$;

-- Hourly bins for the shift that STARTS on p_date, using the schedule in force
-- on that date (historical reports keep their original definitions, KPI-4).
create or replace function kpi_hourly(p_date date) returns jsonb
language plpgsql stable security definer set search_path = public as $fn$
declare
  s reporting_schedules := private.schedule_at(p_date);
  shift_start timestamptz := ((p_date::timestamp + s.shift_start) at time zone s.timezone);
begin
  if not private.kpi_allowed() then raise exception 'reporting permission required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'date', p_date, 'shiftStart', s.shift_start, 'timezone', s.timezone,
    'bins', (
      select jsonb_agg(jsonb_build_object('index', g.i, 'startsAt', shift_start + make_interval(hours => g.i),
        'count', (select count(*) from requests r
                  where r.request_timestamp >= shift_start + make_interval(hours => g.i)
                    and r.request_timestamp <  shift_start + make_interval(hours => g.i + 1))) order by g.i)
      from generate_series(0, s.interval_count - 1) as g(i)));
end
$fn$;

-- ---------------------------------------------------------- worker functions
create or replace function claim_outbox(p_limit integer, p_lock_timeout_seconds integer default 300)
returns setof workflow_outbox
language sql security invoker set search_path = public as $$
  update workflow_outbox o set status = 'PROCESSING', attempts = o.attempts + 1, locked_at = now()
  where o.id in (
    select id from workflow_outbox
    where (status = 'PENDING' and available_at <= now())
       or (status = 'PROCESSING' and locked_at < now() - make_interval(secs => p_lock_timeout_seconds))
    order by available_at
    limit greatest(p_limit, 1)
    for update skip locked)
  returning o.*
$$;

-- NOT-5: administrator-only retry/abandon of dead-lettered work, reasoned + audited.
create or replace function admin_outbox_action(p_id uuid, p_action text, p_actor uuid, p_reason text)
returns jsonb
language plpgsql security invoker set search_path = public as $fn$
declare
  o workflow_outbox;
begin
  if p_action not in ('RETRY', 'ABANDON') then
    return jsonb_build_object('ok', false, 'code', 'INVALID_ACTION');
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED');
  end if;
  if not exists (select 1 from profiles where id = p_actor and is_admin and account_status = 'ACTIVE') then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;
  select * into o from workflow_outbox where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if o.status <> 'DEAD_LETTER' then return jsonb_build_object('ok', false, 'code', 'INVALID_STATE'); end if;
  if p_action = 'RETRY' then
    update workflow_outbox set status = 'PENDING', attempts = 0, available_at = now(), dead_lettered_at = null where id = p_id;
  else
    update workflow_outbox set status = 'ABANDONED' where id = p_id;
  end if;
  insert into audit_events (event_type, actor_id, subject_type, subject_id, reason, metadata)
  values ('OUTBOX_' || p_action, p_actor, 'workflow_outbox', p_id::text, p_reason,
          jsonb_build_object('previous_status', o.status, 'attempts', o.attempts, 'last_error', o.last_error));
  return jsonb_build_object('ok', true);
end
$fn$;

-- --------------------------------------------------------- account approval
-- SEA-7: new accounts stay PENDING_APPROVAL until an administrator approves
-- AND assigns a role. HUB-4: audited.
create or replace function admin_approve_account(p_user uuid, p_role user_role, p_actor uuid, p_reason text)
returns jsonb
language plpgsql security invoker set search_path = public as $fn$
begin
  if not exists (select 1 from profiles where id = p_actor and is_admin and account_status = 'ACTIVE') then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED');
  end if;
  update profiles set role = p_role, account_status = 'ACTIVE', updated_at = now()
  where id = p_user and account_status = 'PENDING_APPROVAL';
  if not found then return jsonb_build_object('ok', false, 'code', 'INVALID_STATE'); end if;
  insert into audit_events (event_type, actor_id, subject_type, subject_id, reason, metadata)
  values ('ACCOUNT_APPROVED', p_actor, 'profile', p_user::text, p_reason, jsonb_build_object('role', p_role));
  return jsonb_build_object('ok', true);
end
$fn$;

create or replace function admin_disable_account(p_user uuid, p_actor uuid, p_reason text)
returns jsonb
language plpgsql security invoker set search_path = public as $fn$
begin
  if not exists (select 1 from profiles where id = p_actor and is_admin and account_status = 'ACTIVE') then
    return jsonb_build_object('ok', false, 'code', 'FORBIDDEN');
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED');
  end if;
  update profiles set account_status = 'DISABLED', updated_at = now() where id = p_user;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  insert into audit_events (event_type, actor_id, subject_type, subject_id, reason)
  values ('ACCOUNT_DISABLED', p_actor, 'profile', p_user::text, p_reason);
  return jsonb_build_object('ok', true);
end
$fn$;

-- ----------------------------------------------------------------- retention
-- NOT-6: expiry honours legal holds; each purge is audited.
create or replace function purge_expired(p_now timestamptz default now()) returns jsonb
language plpgsql security invoker set search_path = public as $fn$
declare
  n_days integer := (select (value #>> '{}')::integer from app_settings where key = 'notification_retention_days');
  c_days integer := (select (value #>> '{}')::integer from app_settings where key = 'callback_retention_days');
  dn integer; dc integer;
begin
  delete from notifications where not legal_hold and created_at < p_now - make_interval(days => n_days);
  get diagnostics dn = row_count;
  delete from seatalk_callback_events where not legal_hold and received_at < p_now - make_interval(days => c_days);
  get diagnostics dc = row_count;
  delete from idempotency_keys where expires_at < p_now;
  insert into audit_events (event_type, metadata)
  values ('RETENTION_PURGE', jsonb_build_object('notifications', dn, 'callbacks', dc, 'at', p_now));
  return jsonb_build_object('notifications', dn, 'callbacks', dc);
end
$fn$;

-- ------------------------------------------------------------------ grants
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function commit_transition, queue_requests, claim_outbox, admin_outbox_action,
  admin_approve_account, admin_disable_account, purge_expired to service_role;
-- KPI functions self-check the reporting permission (backend + RLS agree).
grant execute on function kpi_summary, kpi_daily, kpi_hourly to authenticated, service_role;
grant usage on schema private to authenticated;
grant execute on function private.active_profile, private.current_role, private.has_reporting,
  private.kpi_allowed, private.schedule_at to authenticated, service_role;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
