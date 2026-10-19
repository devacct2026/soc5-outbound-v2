-- SOC5 Outbound v2: base schema (authoritative Supabase migration history).
-- Independent of the original (read-only) repository; no production data.
-- Ordered BEFORE 20261019000000_apr3_rejection_disposition.sql, which alters
-- `requests` and `request_events` created here.

create schema if not exists private;

create type user_role as enum ('ops_pic', 'fte_ops', 'fte_mm', 'doc_officer');
create type truck_size as enum ('4W', '4WAUV', '4WCV', '6W', '10W', '6WF');
create type truck_type as enum ('WETLEASE', 'DRYLEASE');
-- Canonical statuses plus raw legacy values preserved by ST-1..ST-6.
create type request_status as enum (
  'PENDING', 'REROUTED', 'REQUESTED', 'REJECTED', 'CANCELLED', 'DOCKING', 'DOCKED',
  'ASSIGNED', 'APPROVED', 'REJECTED_BY_MM', 'FOR_DOCKING', 'CONFIRMED'
);

-- ---------------------------------------------------------------- profiles
create table profiles (
  id uuid primary key references auth.users (id) on delete restrict,
  role user_role,                                   -- null until an admin assigns one (SEA-7)
  full_name text not null default '',
  email text not null,
  ops_id text,
  seatalk_employee_code text unique,
  account_status text not null default 'PENDING_APPROVAL'
    check (account_status in ('PENDING_APPROVAL', 'ACTIVE', 'DISABLED')),
  is_admin boolean not null default false,
  reporting_permission boolean not null default false,  -- KPI-6, independent of role
  last_seen_at timestamptz,                              -- SeaTalk presence (SEA-6)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Operational access requires ACTIVE status AND an explicitly assigned role.
  constraint profiles_active_requires_role check (account_status <> 'ACTIVE' or role is not null)
);
create unique index profiles_email_key on profiles (lower(email));

-- ---------------------------------------------------------------- clusters
create table clusters (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  hub_name text,
  region text not null check (char_length(region) between 1 and 120),
  dock_no text not null check (char_length(dock_no) between 1 and 50),
  backlogs integer not null default 0 check (backlogs >= 0),
  backlogs_timestamp timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (name, hub_name, dock_no)
);

-- ---------------------------------------------------------------- requests
create table requests (
  id uuid primary key default gen_random_uuid(),
  request_timestamp timestamptz not null default now(),
  submitted_at timestamptz not null default now(),      -- latest submission (KPI-2)
  cluster_id uuid references clusters (id),
  cluster text not null check (char_length(cluster) between 1 and 120),
  region text not null check (char_length(region) between 1 and 120),
  dock_no text not null check (char_length(dock_no) between 1 and 50),
  backlogs integer not null check (backlogs >= 0),
  backlogs_timestamp date,
  truck_size truck_size not null,
  truck_type truck_type not null,
  created_by uuid not null references profiles (id),
  creator_role user_role not null check (creator_role in ('ops_pic', 'fte_ops')),
  status request_status not null default 'PENDING',
  approval_status text not null default 'PENDING'
    check (approval_status in ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  approval_version integer not null default 1,
  approval_correlation_id uuid not null default gen_random_uuid(),
  approval_source text check (approval_source in ('WEB', 'SEATALK')),
  approved_at timestamptz,
  approved_by uuid references profiles (id),
  rejection_return_role text check (rejection_return_role in ('ops_pic', 'fte_ops')),
  rejection_remarks text check (char_length(rejection_remarks) <= 2000),
  rejected_at timestamptz,
  rejected_by uuid references profiles (id),
  cancellation_remarks text check (char_length(cancellation_remarks) <= 2000),
  cancelled_at timestamptz,
  cancelled_by uuid references profiles (id),
  plate_number text,
  provide_time timestamptz,
  truck_assigned_by uuid references profiles (id),
  driver_id text check (driver_id ~ '^[0-9]{1,10}$'),
  driver_assigned_at timestamptz,
  driver_assigned_by uuid references profiles (id),
  linehaul_trip_no text,
  linehaul_trip_at timestamptz,
  docked_at timestamptz,
  -- Historical preservation (ST-1..ST-6): original value + review flag.
  legacy_status text,
  legacy_review text check (legacy_review in ('UNRESOLVED', 'VERIFIED')),
  row_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Canonical status <-> approval_status pairs (ST-8: two distinct fields that must agree).
  -- Legacy raw statuses are unconstrained here; reconciliation handles them (ST-1..ST-6).
  constraint requests_status_approval_pair check (
    case status
      when 'PENDING' then approval_status = 'PENDING'
      when 'REROUTED' then approval_status = 'PENDING'
      when 'REQUESTED' then approval_status = 'APPROVED'
      when 'DOCKING' then approval_status = 'APPROVED'
      when 'DOCKED' then approval_status = 'APPROVED'
      when 'REJECTED' then approval_status = 'REJECTED'
      when 'CANCELLED' then approval_status = 'CANCELLED'
      else true
    end
  ),
  -- Docking milestones must be internally consistent.
  constraint requests_docked_requires_trip check (status <> 'DOCKED' or (linehaul_trip_no is not null and driver_id is not null)),
  constraint requests_docking_requires_plate check (status not in ('DOCKING', 'DOCKED') or plate_number is not null)
);
create index requests_status_created_idx on requests (status, created_at desc, id desc);
create index requests_creator_idx on requests (created_by, created_at desc, id desc);
create index requests_timestamp_idx on requests (request_timestamp);

-- ---------------------------------------------------------- request_events
-- Append-only audit trail. The immutability trigger is installed by
-- 20261019000000_apr3_rejection_disposition.sql.
create table request_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references requests (id) on delete restrict,
  event_type text not null,
  actor_id uuid references profiles (id),
  creator_id uuid references profiles (id),
  from_status text,
  to_status text,
  from_approval_status text,
  to_approval_status text,
  approval_version integer,
  metadata jsonb not null default '{}'::jsonb,   -- remarks, disposition, before/after values
  correlation_id uuid,
  created_at timestamptz not null default now()
);
create index request_events_request_idx on request_events (request_id, created_at desc, id desc);

-- ----------------------------------------------------------- notifications
-- NOT-3: persistence (this row), provider acknowledgment (workflow_outbox),
-- and read receipts (notification_reads) are separate delivery facts.
create table notifications (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null unique,
  request_id uuid references requests (id) on delete restrict,
  event_type text not null,
  title text not null,
  body text not null default '',
  recipient_user_id uuid references profiles (id),
  recipient_role user_role,
  legal_hold boolean not null default false,
  created_at timestamptz not null default now(),
  constraint notifications_has_recipient check (recipient_user_id is not null or recipient_role is not null)
);
create index notifications_user_idx on notifications (recipient_user_id, created_at desc);
create index notifications_role_idx on notifications (recipient_role, created_at desc);

create table notification_reads (
  notification_id uuid not null references notifications (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (notification_id, user_id)
);

-- ---------------------------------------------------------- workflow_outbox
-- Durable external side-effect intent processed by the background worker.
create table workflow_outbox (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  channel text not null check (channel in ('SEATALK_ALERT', 'SEATALK_APPROVAL_SYNC', 'GOOGLE_SHEETS')),
  event_type text not null,
  aggregate_id uuid,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'PENDING'
    check (status in ('PENDING', 'PROCESSING', 'COMPLETED', 'DEAD_LETTER', 'ABANDONED')),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  provider_ack_at timestamptz,              -- NOT-3 provider acknowledgment
  last_error text,
  completed_at timestamptz,
  dead_lettered_at timestamptz,
  created_at timestamptz not null default now()
);
create index workflow_outbox_due_idx on workflow_outbox (available_at) where status = 'PENDING';

-- --------------------------------------------------------- idempotency keys
create table idempotency_keys (
  actor_id uuid not null,
  method text not null,
  path text not null,
  key text not null check (char_length(key) between 8 and 200),
  payload_hash text not null,
  response_status integer not null,
  response_body jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),  -- OPS-4
  primary key (actor_id, method, path, key)
);

-- ------------------------------------------------------------ SeaTalk state
create table seatalk_callback_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'seatalk',
  event_id text,                       -- provider-scoped event id (SEA-4)
  fallback_hash text,                  -- content fingerprint only when event_id absent
  payload_hash text not null,
  request_id uuid references requests (id),
  employee_code text,
  action text,
  status text not null default 'RECEIVED' check (status in ('RECEIVED', 'PROCESSED', 'IGNORED', 'CONFLICT', 'FAILED')),
  failure_reason text,
  legal_hold boolean not null default false,
  received_at timestamptz not null default now(),
  constraint seatalk_callback_has_identity check (event_id is not null or fallback_hash is not null)
);
create unique index seatalk_callback_provider_event_key on seatalk_callback_events (provider, event_id) where event_id is not null;
create unique index seatalk_callback_fallback_key on seatalk_callback_events (provider, fallback_hash) where event_id is null;

create table seatalk_approval_assignments (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests (id),
  assignee_id uuid not null references profiles (id),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CLOSED')),
  provider_item_id text unique,          -- SeaTalk Approval Center item id
  token_hash text,                       -- SHA-256 of the one-time approval token
  sent_at timestamptz,
  expires_at timestamptz,
  responded_at timestamptz,
  routing_cycle integer not null default 1,
  correlation_id uuid,
  created_at timestamptz not null default now()
);
create unique index seatalk_one_open_assignment on seatalk_approval_assignments (request_id) where status = 'PENDING';

create table approval_routing_cursors (
  scope text primary key,
  last_profile_id uuid references profiles (id),
  updated_at timestamptz not null default now()
);

-- -------------------------------------------------------- reporting + config
create table intraday_dispatch (
  dispatch_date date not null,
  hour smallint not null check (hour between 0 and 23),
  order_qty numeric not null check (order_qty >= 0),
  synced_at timestamptz not null default now(),
  primary key (dispatch_date, hour)
);

-- KPI-4: schedule definitions are versioned so historical reports keep theirs.
create table reporting_schedules (
  id uuid primary key default gen_random_uuid(),
  effective_from date not null unique,
  shift_start time not null default '18:00',
  interval_count integer not null default 13 check (interval_count between 1 and 24),
  timezone text not null default 'Asia/Manila',
  created_by uuid references profiles (id),
  created_at timestamptz not null default now()
);
insert into reporting_schedules (effective_from) values ('2000-01-01');

create table app_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid references profiles (id),
  updated_at timestamptz not null default now()
);
insert into app_settings (key, value) values
  ('presence_freshness_seconds', '60'),          -- sandbox default (SEA-6)
  ('assignment_expiry_seconds', '180'),          -- sandbox default (SEA-6)
  ('worker_max_attempts', '5'),
  ('worker_backoff_base_seconds', '30'),
  ('worker_backoff_max_seconds', '3600'),
  ('notification_retention_days', '365'),
  ('callback_retention_days', '90'),
  ('default_report_period_days', '30');

-- Immutable administrative audit (overrides, notification replay/abandon,
-- account approval, settings changes). HUB-4, NOT-5.
create table audit_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  actor_id uuid references profiles (id),
  subject_type text,
  subject_id text,
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create or replace function private.reject_mutation() returns trigger
language plpgsql as $fn$
begin
  raise exception '% is append-only', tg_table_name;
end
$fn$;
create trigger audit_events_no_update_delete
  before update or delete on audit_events
  for each row execute function private.reject_mutation();

-- ---------------------------------------------------------- RLS helpers
create or replace function private.active_profile() returns profiles
language sql stable security definer set search_path = public as $$
  select p.* from profiles p
  where p.id = auth.uid() and p.account_status = 'ACTIVE' and p.role is not null
$$;
create or replace function private.current_role() returns user_role
language sql stable security definer set search_path = public as $$
  select (private.active_profile()).role
$$;
create or replace function private.has_reporting() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((private.active_profile()).reporting_permission, false)
$$;

-- ----------------------------------------------------------------- RLS
alter table profiles enable row level security;
alter table clusters enable row level security;
alter table requests enable row level security;
alter table request_events enable row level security;
alter table notifications enable row level security;
alter table notification_reads enable row level security;
alter table workflow_outbox enable row level security;
alter table idempotency_keys enable row level security;
alter table seatalk_callback_events enable row level security;
alter table seatalk_approval_assignments enable row level security;
alter table approval_routing_cursors enable row level security;
alter table intraday_dispatch enable row level security;
alter table reporting_schedules enable row level security;
alter table app_settings enable row level security;
alter table audit_events enable row level security;

-- Browser roles never write; backend uses service_role (server-only).
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on clusters, requests, request_events, notifications,
  notification_reads, intraday_dispatch to authenticated;
-- Profiles: column-level grant. Privilege flags (is_admin, reporting_permission),
-- SeaTalk employee code and presence are NOT readable by browsers; the API exposes
-- the caller's own flags via /api/v1/auth/me.
grant select (id, role, full_name, ops_id, account_status) on profiles to authenticated;
grant insert, update on notification_reads to authenticated;

create policy profiles_read_own on profiles for select to authenticated
  using (id = auth.uid() and account_status = 'ACTIVE');
create policy profiles_read_ops on profiles for select to authenticated
  using (private.current_role() in ('fte_ops', 'fte_mm') and account_status = 'ACTIVE');

create policy clusters_read on clusters for select to authenticated
  using (private.current_role() is not null);

-- HUB-1/HUB-2: Ops PIC creator-scoped; other operational roles broad.
create policy requests_read on requests for select to authenticated
  using (
    private.current_role() is not null
    and (created_by = auth.uid() or private.current_role() in ('fte_ops', 'fte_mm', 'doc_officer'))
  );
create policy request_events_read on request_events for select to authenticated
  using (exists (select 1 from requests r where r.id = request_events.request_id));  -- inherits requests_read

create policy notifications_read on notifications for select to authenticated
  using (
    private.current_role() is not null
    and (recipient_user_id = auth.uid() or recipient_role = private.current_role())
  );
create policy notification_reads_own_select on notification_reads for select to authenticated
  using (user_id = auth.uid());
create policy notification_reads_own_insert on notification_reads for insert to authenticated
  with check (user_id = auth.uid() and exists (select 1 from notifications n where n.id = notification_id));

-- HUB-5: all four operational roles read Intraday Dispatch.
create policy intraday_read on intraday_dispatch for select to authenticated
  using (private.current_role() is not null);

-- Server-only tables: RLS on, no policies, no grants => denied to browsers.

-- Realtime publication (RLS remains the visibility boundary).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table requests, notifications, intraday_dispatch;
  end if;
end $$;
