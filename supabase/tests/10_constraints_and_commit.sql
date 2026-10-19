\set ON_ERROR_STOP on
create function pg_temp.ok(c boolean, m text) returns void language plpgsql as $$ begin if not coalesce(c,false) then raise exception 'ASSERT FAILED: %', m; end if; end $$;
create function pg_temp.fails(sql text, m text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'EXPECTED FAILURE: %', m;
end $$;

-- accounts: ACTIVE requires an assigned role
select pg_temp.fails($$insert into auth.users values ('00000000-0000-0000-0000-0000000000ff','x@t'); insert into profiles (id,email,account_status) values ('00000000-0000-0000-0000-0000000000ff','x@t','ACTIVE')$$, 'active profile without role');

-- create through commit_transition
select pg_temp.ok((commit_transition(
  '{"id":"11111111-1111-1111-1111-111111111101","request_timestamp":"2026-10-19T10:00:00Z","submitted_at":"2026-10-19T10:00:00Z","cluster":"C1","region":"R","dock_no":"D1","backlogs":3,"truck_size":"4W","truck_type":"WETLEASE","created_by":"00000000-0000-0000-0000-0000000000a1","creator_role":"ops_pic","status":"PENDING","approval_status":"PENDING","approval_version":1,"approval_correlation_id":"22222222-2222-2222-2222-222222222201","row_version":1,"created_at":"2026-10-19T10:00:00Z","updated_at":"2026-10-19T10:00:00Z"}'::jsonb,
  null,
  '{"event_type":"REQUEST_CREATED","actor_id":"00000000-0000-0000-0000-0000000000a1","to_status":"PENDING","to_approval_status":"PENDING","approval_version":1,"correlation_id":"22222222-2222-2222-2222-222222222201"}'::jsonb,
  '[{"dedupe_key":"n1","event_type":"REQUEST_CREATED","title":"New","recipient_role":"fte_ops"}]'::jsonb,
  '[{"idempotency_key":"o1","channel":"SEATALK_ALERT","event_type":"REQUEST_CREATED"}]'::jsonb,
  '{"actor_id":"00000000-0000-0000-0000-0000000000a1","method":"POST","path":"/api/v1/requests","key":"idem-key-0001","payload_hash":"h","response_status":201,"response_body":{"ok":1}}'::jsonb
)->>'ok')::boolean, 'create commits');
select pg_temp.ok((select count(*) from request_events where request_id='11111111-1111-1111-1111-111111111101')=1, 'one event');
select pg_temp.ok((select count(*) from notifications)=1 and (select count(*) from workflow_outbox)=1, 'notification + outbox intent');
select pg_temp.ok((select count(*) from idempotency_keys)=1, 'idempotency stored with request');

-- optimistic concurrency: stale version rejected, nothing written
select pg_temp.ok((commit_transition(
  '{"id":"11111111-1111-1111-1111-111111111101","cluster":"C1","region":"R","dock_no":"D1","backlogs":3,"truck_size":"4W","truck_type":"WETLEASE","status":"REQUESTED","approval_status":"APPROVED","approval_version":1,"approval_correlation_id":"22222222-2222-2222-2222-222222222201","submitted_at":"2026-10-19T10:00:00Z"}'::jsonb,
  99, '{"event_type":"REQUEST_APPROVED"}'::jsonb)->>'code')='VERSION_CONFLICT', 'stale version');
select pg_temp.ok((select count(*) from request_events)=1, 'conflict wrote no event');

-- duplicate notification/outbox intents are ignored, never duplicated
select commit_transition(
  '{"id":"11111111-1111-1111-1111-111111111101","cluster":"C1","region":"R","dock_no":"D1","backlogs":3,"truck_size":"4W","truck_type":"WETLEASE","status":"REQUESTED","approval_status":"APPROVED","approval_version":1,"approval_correlation_id":"22222222-2222-2222-2222-222222222201","submitted_at":"2026-10-19T10:00:00Z","approved_at":"2026-10-19T10:05:00Z"}'::jsonb,
  1, '{"event_type":"REQUEST_APPROVED","from_status":"PENDING","to_status":"REQUESTED"}'::jsonb,
  '[{"dedupe_key":"n1","event_type":"X","title":"dup","recipient_role":"fte_ops"}]'::jsonb);
select pg_temp.ok((select count(*) from notifications)=1, 'duplicate dedupe_key ignored');
select pg_temp.ok((select row_version from requests where id='11111111-1111-1111-1111-111111111101')=2, 'row_version bumped');

-- check constraints: APR-3 consistency and docking integrity
select pg_temp.fails($$update requests set status='REJECTED', approval_status='REJECTED', rejection_disposition='FINAL_NO_ROUTE', rejection_return_role='fte_ops' where id='11111111-1111-1111-1111-111111111101'$$, 'FINAL_NO_ROUTE with return role');
select pg_temp.fails($$update requests set status='REJECTED', approval_status='PENDING', rejection_disposition='RETURN_TO_FTE_OPS', rejection_return_role='fte_ops' where id='11111111-1111-1111-1111-111111111101'$$, 'REJECTED with approval PENDING');
select pg_temp.fails($$update requests set status='DOCKED' where id='11111111-1111-1111-1111-111111111101'$$, 'DOCKED without trip/driver');
select pg_temp.fails($$update requests set driver_id='12ab' where id='11111111-1111-1111-1111-111111111101'$$, 'non-numeric driver');
select pg_temp.fails($$update requests set status='PENDING', rejection_disposition='FINAL_NO_ROUTE' where id='11111111-1111-1111-1111-111111111101'$$, 'disposition on non-rejected row');
update requests set status='REJECTED', approval_status='REJECTED', rejection_disposition='FINAL_NO_ROUTE', rejection_return_role=null where id='11111111-1111-1111-1111-111111111101';

-- append-only audit
select pg_temp.fails($$update request_events set event_type='X'$$, 'update request_events');
select pg_temp.fails($$delete from request_events$$, 'delete request_events');
select pg_temp.fails($$truncate request_events$$, 'truncate request_events');
insert into audit_events (event_type) values ('T');
select pg_temp.fails($$update audit_events set event_type='X'$$, 'update audit');
select pg_temp.fails($$delete from audit_events$$, 'delete audit');
select pg_temp.fails($$delete from requests$$, 'delete request with events (restrict)');
