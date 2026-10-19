\set ON_ERROR_STOP on
create function pg_temp.ok(c boolean, m text) returns void language plpgsql as $$ begin if not coalesce(c,false) then raise exception 'ASSERT FAILED: %', m; end if; end $$;
create function pg_temp.fails(sql text, m text) returns void language plpgsql as $$
begin
  begin execute sql; exception when insufficient_privilege then return; end;  -- must be a privilege error, not any error
  raise exception 'EXPECTED PRIVILEGE FAILURE: %', m;
end $$;

-- service_role (the backend) can run every workflow function under its real grants
set role service_role;
select pg_temp.ok((commit_transition(
  '{"id":"44444444-4444-4444-4444-444444444401","cluster":"C","region":"R","dock_no":"D","backlogs":1,"truck_size":"4W","truck_type":"DRYLEASE","created_by":"00000000-0000-0000-0000-0000000000a1","creator_role":"ops_pic","status":"PENDING","approval_status":"PENDING","approval_version":1,"approval_correlation_id":"55555555-5555-5555-5555-555555555501","submitted_at":"2026-10-21T01:00:00Z","request_timestamp":"2026-10-21T01:00:00Z","created_at":"2026-10-21T01:00:00Z","updated_at":"2026-10-21T01:00:00Z","row_version":1}'::jsonb,
  null, '{"event_type":"REQUEST_CREATED"}'::jsonb)->>'ok')::boolean, 'service_role can commit');
select pg_temp.ok((select count(*) from queue_requests('00000000-0000-0000-0000-0000000000b1','fte_ops',10)) >= 1, 'service_role can read the queue');
select pg_temp.ok((select count(*) from claim_outbox(1)) >= 0, 'service_role can claim outbox');
select pg_temp.ok((kpi_summary('2026-10-21','2026-10-21')->>'total')::int = 1, 'service_role (API-authorized) can read KPI');
reset role;

-- browsers cannot call privileged functions at all
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', false);
set role authenticated;  -- even an ADMIN browser session
select pg_temp.fails($$select admin_outbox_action(gen_random_uuid(), 'RETRY', '00000000-0000-0000-0000-0000000000e1', 'x')$$, 'admin_outbox_action not callable by browsers');
select pg_temp.fails($$select admin_approve_account('00000000-0000-0000-0000-0000000000f1', 'fte_mm', '00000000-0000-0000-0000-0000000000e1', 'x')$$, 'admin_approve_account not callable by browsers');
select pg_temp.fails($$select admin_disable_account('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', 'x')$$, 'admin_disable_account not callable by browsers');
select pg_temp.fails($$select purge_expired()$$, 'purge_expired not callable by browsers');
select pg_temp.fails($$select * from claim_outbox(1)$$, 'claim_outbox not callable by browsers');
select pg_temp.fails($$select * from queue_requests(gen_random_uuid(), 'fte_ops', 10)$$, 'queue_requests not callable by browsers (service-side only)');
select pg_temp.fails($$update profiles set is_admin = true where id = '00000000-0000-0000-0000-0000000000a1'$$, 'browser cannot self-promote');
select pg_temp.fails($$update profiles set reporting_permission = true$$, 'browser cannot grant reporting permission');
select pg_temp.fails($$insert into audit_events (event_type) values ('FORGED')$$, 'browser cannot write audit');
select pg_temp.fails($$select count(*) from audit_events$$, 'audit not readable by browsers');
reset role;

-- reporting permission is enforced inside the database too (backend and RLS agree)
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000071', false);
set role authenticated;
select pg_temp.ok((kpi_summary('2026-10-21','2026-10-21')->>'total')::int = 1, 'reporting-permission user can read KPI');
select pg_temp.ok(jsonb_array_length(kpi_daily('2026-10-01','2026-10-31')) >= 1, 'daily KPI');
reset role;

-- a user with the permission loses it immediately when revoked
update profiles set reporting_permission = false where id = '00000000-0000-0000-0000-000000000071';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000071', false);
set role authenticated;
select pg_temp.fails($$select kpi_summary('2026-10-21','2026-10-21')$$, 'revoked reporting permission denied on the next call');
reset role;
update profiles set reporting_permission = true where id = '00000000-0000-0000-0000-000000000071';

-- disabled operational user is blocked from every browser-readable table at once
update profiles set account_status = 'DISABLED' where id = '00000000-0000-0000-0000-0000000000d1';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', false);
set role authenticated;
select pg_temp.ok((select count(*) from requests) = 0 and (select count(*) from intraday_dispatch) = 0 and (select count(*) from request_events) = 0, 'disabled user reads nothing');
reset role;
update profiles set account_status = 'ACTIVE' where id = '00000000-0000-0000-0000-0000000000d1';
