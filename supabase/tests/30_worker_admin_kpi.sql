\set ON_ERROR_STOP on
create function pg_temp.ok(c boolean, m text) returns void language plpgsql as $$ begin if not coalesce(c,false) then raise exception 'ASSERT FAILED: %', m; end if; end $$;
\set admin '00000000-0000-0000-0000-0000000000e1'
\set pic '00000000-0000-0000-0000-0000000000a1'

-- Outbox claim: due rows only; claimed rows are not re-claimable until lock timeout
insert into workflow_outbox (idempotency_key, channel, event_type, status, available_at) values
 ('w-due','SEATALK_ALERT','E','PENDING', now() - interval '1 minute'),
 ('w-future','SEATALK_ALERT','E','PENDING', now() + interval '1 hour'),
 ('w-dead','SEATALK_ALERT','E','DEAD_LETTER', now() - interval '1 minute');
select pg_temp.ok((select count(*) from claim_outbox(10)) >= 1, 'due row claimed');
select pg_temp.ok((select status from workflow_outbox where idempotency_key='w-due')='PROCESSING' and (select attempts from workflow_outbox where idempotency_key='w-due')=1, 'claimed => PROCESSING, attempts=1');
select pg_temp.ok((select count(*) from claim_outbox(10) where idempotency_key='w-due')=0, 'no double claim');
select pg_temp.ok((select status from workflow_outbox where idempotency_key='w-future')='PENDING', 'future row untouched');
select pg_temp.ok((select status from workflow_outbox where idempotency_key='w-dead')='DEAD_LETTER', 'dead letters never auto-claimed');
-- stale PROCESSING recovers after lock timeout
update workflow_outbox set locked_at = now() - interval '10 minutes' where idempotency_key='w-due';
select pg_temp.ok((select count(*) from claim_outbox(10) where idempotency_key='w-due')=1, 'stale lock recovered');

-- NOT-5: admin-only, reasoned, audited, only for dead letters
select pg_temp.ok((admin_outbox_action((select id from workflow_outbox where idempotency_key='w-dead'), 'RETRY', :'pic', 'because')->>'code')='FORBIDDEN', 'non-admin denied');
select pg_temp.ok((admin_outbox_action((select id from workflow_outbox where idempotency_key='w-dead'), 'RETRY', :'admin', '  ')->>'code')='REASON_REQUIRED', 'reason required');
select pg_temp.ok((admin_outbox_action((select id from workflow_outbox where idempotency_key='w-future'), 'RETRY', :'admin', 'x')->>'code')='INVALID_STATE', 'only dead letters');
select pg_temp.ok((admin_outbox_action((select id from workflow_outbox where idempotency_key='w-dead'), 'RETRY', :'admin', 'provider recovered')->>'ok')::boolean, 'admin retry');
select pg_temp.ok((select status from workflow_outbox where idempotency_key='w-dead')='PENDING', 'retry requeues');
select pg_temp.ok((select count(*) from audit_events where event_type='OUTBOX_RETRY' and reason='provider recovered')=1, 'audited');

-- SEA-7: account approval requires admin + role + reason
select pg_temp.ok((admin_approve_account('00000000-0000-0000-0000-0000000000f1','fte_mm', :'pic', 'ok')->>'code')='FORBIDDEN', 'non-admin cannot approve');
select pg_temp.ok((select account_status from profiles where id='00000000-0000-0000-0000-0000000000f1')='PENDING_APPROVAL', 'still pending');
select pg_temp.ok((admin_approve_account('00000000-0000-0000-0000-0000000000f1','fte_mm', :'admin', 'verified employee')->>'ok')::boolean, 'admin approves with role');
select pg_temp.ok((select role::text from profiles where id='00000000-0000-0000-0000-0000000000f1')='fte_mm', 'role assigned');
select pg_temp.ok((admin_approve_account('00000000-0000-0000-0000-0000000000f1','fte_mm', :'admin', 'again')->>'code')='INVALID_STATE', 'not re-approvable');
update profiles set account_status='PENDING_APPROVAL', role=null where id='00000000-0000-0000-0000-0000000000f1';

-- Retention honours legal hold
insert into notifications (dedupe_key, event_type, title, recipient_role, created_at, legal_hold) values
 ('old-1','E','old','fte_ops', now() - interval '2 years', false),
 ('old-held','E','held','fte_ops', now() - interval '2 years', true);
select purge_expired();
select pg_temp.ok(not exists (select 1 from notifications where dedupe_key='old-1'), 'expired notification purged');
select pg_temp.ok(exists (select 1 from notifications where dedupe_key='old-held'), 'legal hold preserved');
select pg_temp.ok(exists (select 1 from audit_events where event_type='RETENTION_PURGE'), 'purge audited');

-- Callback dedupe uniqueness (SEA-4)
insert into seatalk_callback_events (provider, event_id, payload_hash) values ('seatalk','e1','h1');
do $$ begin
  begin insert into seatalk_callback_events (provider, event_id, payload_hash) values ('seatalk','e1','h1'); raise exception 'dup accepted';
  exception when unique_violation then null; end;
  insert into seatalk_callback_events (provider, event_id, payload_hash) values ('other','e1','h1');  -- provider-scoped
end $$;

-- KPI: approval = approved_at - LATEST submission (KPI-2 Option B); schedule-versioned hourly bins
insert into requests (id, request_timestamp, submitted_at, approved_at, provide_time, linehaul_trip_at, cluster, region, dock_no, backlogs, truck_size, truck_type, created_by, creator_role, status, approval_status, approval_correlation_id, plate_number, driver_id, linehaul_trip_no) values
 ('33333333-3333-3333-3333-333333333301','2026-10-20T10:00:00Z','2026-10-20T10:30:00Z','2026-10-20T10:40:00Z','2026-10-20T11:00:00Z','2026-10-20T12:00:00Z','C','R','D',1,'4W','DRYLEASE',:'pic','ops_pic','DOCKED','APPROVED',gen_random_uuid(),'P','1','T1');
select pg_temp.ok((kpi_summary('2026-10-20','2026-10-20')->>'averageApprovalMinutes')::numeric = 10, 'approval minutes use latest submission');
select pg_temp.ok((kpi_summary('2026-10-20','2026-10-20')->>'averageWaitingMinutes')::numeric = 60, 'waiting = provide_time - request_timestamp');
select pg_temp.ok((kpi_summary('2026-10-20','2026-10-20')->>'averageDwellMinutes')::numeric = 120, 'dwell = trip_at - request_timestamp');
select pg_temp.ok((kpi_summary('2026-10-20','2026-10-20')->>'confirmed')::int = 1, 'confirmed = DOCKED');
select pg_temp.ok(jsonb_array_length(kpi_hourly('2026-10-20')->'bins') = 13, '13 hourly bins by default');
-- 2026-10-20T10:00Z = 18:00 Manila => first bin
select pg_temp.ok((kpi_hourly('2026-10-20')->'bins'->0->>'count')::int = 1, 'shift bin 0 counts 18:00 Manila request');
-- a later schedule must not rewrite history
insert into reporting_schedules (effective_from, shift_start, interval_count, timezone) values ('2026-11-01','06:00',12,'Asia/Manila');
select pg_temp.ok(jsonb_array_length(kpi_hourly('2026-10-20')->'bins') = 13, 'historical report keeps original schedule');
select pg_temp.ok(jsonb_array_length(kpi_hourly('2026-11-02')->'bins') = 12, 'new schedule applies going forward');

-- Channel filter: rows of channels without a handler are never claimed (attempts not burned)
insert into workflow_outbox (idempotency_key, channel, event_type, status, available_at) values
 ('c-sheets','GOOGLE_SHEETS','E','PENDING', now() - interval '1 minute');
select pg_temp.ok((select count(*) from claim_outbox(10, 300, array['SEATALK_ALERT']) where idempotency_key='c-sheets')=0, 'channel filter excludes sheets');
select pg_temp.ok((select attempts from workflow_outbox where idempotency_key='c-sheets')=0, 'attempts untouched');
select pg_temp.ok((select count(*) from claim_outbox(10, 300, array['GOOGLE_SHEETS']) where idempotency_key='c-sheets')=1, 'sheets claimed when handled');
