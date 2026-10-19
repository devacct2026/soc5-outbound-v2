\set ON_ERROR_STOP on
create function pg_temp.ok(c boolean, m text) returns void language plpgsql as $$ begin if not coalesce(c,false) then raise exception 'ASSERT FAILED: %', m; end if; end $$;
create function pg_temp.fails(sql text, m text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'EXPECTED FAILURE: %', m;
end $$;
create function pg_temp.n(t text) returns bigint language plpgsql as $$ declare c bigint; begin execute format('select count(*) from %s', t) into c; return c; end $$;
\set a1 '00000000-0000-0000-0000-0000000000a1'
\set a2 '00000000-0000-0000-0000-0000000000a2'
\set b1 '00000000-0000-0000-0000-0000000000b1'

-- fixtures. ...01 (created by a1) is FINAL_NO_ROUTE from the previous file.
insert into requests (id, cluster, region, dock_no, backlogs, truck_size, truck_type, created_by, creator_role, status, approval_status, approval_correlation_id, rejection_disposition, rejection_return_role, plate_number, driver_id, created_at) values
 ('11111111-1111-1111-1111-111111111102','C','R','D',1,'4W','DRYLEASE',:'a2','ops_pic','REJECTED','REJECTED',gen_random_uuid(),'RETURN_TO_OPS_PIC','ops_pic',null,null,'2026-10-19T09:00:00Z'),
 ('11111111-1111-1111-1111-111111111103','C','R','D',1,'4W','DRYLEASE',:'b1','fte_ops','REJECTED','REJECTED',gen_random_uuid(),'RETURN_TO_FTE_OPS','fte_ops',null,null,'2026-10-19T09:01:00Z'),
 ('11111111-1111-1111-1111-111111111104','C','R','D',1,'4W','DRYLEASE',:'a1','ops_pic','DOCKING','APPROVED',gen_random_uuid(),null,null,'PLT1',null,'2026-10-19T09:02:00Z'),
 ('11111111-1111-1111-1111-111111111105','C','R','D',1,'4W','DRYLEASE',:'a1','ops_pic','DOCKING','APPROVED',gen_random_uuid(),null,null,'PLT2','123','2026-10-19T09:03:00Z'),
 ('11111111-1111-1111-1111-111111111106','C','R','D',1,'4W','DRYLEASE',:'a1','ops_pic','REQUESTED','APPROVED',gen_random_uuid(),null,null,null,null,'2026-10-19T09:04:00Z'),
 ('11111111-1111-1111-1111-111111111107','C','R','D',1,'4W','DRYLEASE',:'a1','ops_pic','ASSIGNED','APPROVED',gen_random_uuid(),null,null,null,null,'2026-10-19T09:05:00Z'),
 ('11111111-1111-1111-1111-111111111108','C','R','D',1,'4W','DRYLEASE',:'a1','ops_pic','PENDING','PENDING',gen_random_uuid(),null,null,null,null,'2026-10-19T09:06:00Z'),
 ('11111111-1111-1111-1111-111111111109','C','R','D',1,'4W','DRYLEASE',:'a1','ops_pic','REJECTED','REJECTED',gen_random_uuid(),'LEGACY_UNRESOLVED',null,null,null,'2026-10-19T09:07:00Z');

create function pg_temp.q(u text, r text) returns text language plpgsql as $$
declare res text;
begin
  select string_agg(right(id::text, 2), ',' order by created_at desc, id desc) into res
  from queue_requests(u::uuid, r::user_role, 100);
  return coalesce(res, '');
end $$;

-- Queue predicates (service role context)
select pg_temp.ok(pg_temp.q('00000000-0000-0000-0000-0000000000b1','fte_ops') = '08,03', 'fte_ops: PENDING + RETURN_TO_FTE_OPS only; final/legacy/ASSIGNED excluded: ' || pg_temp.q('00000000-0000-0000-0000-0000000000b1','fte_ops'));
select pg_temp.ok(pg_temp.q('00000000-0000-0000-0000-0000000000a1','ops_pic') = '05', 'creator ops_pic: DOCKING with driver only');
select pg_temp.ok(pg_temp.q('00000000-0000-0000-0000-0000000000a2','ops_pic') = '02', 'ops_pic returned rejection visible to its creator only');
select pg_temp.ok(pg_temp.q('00000000-0000-0000-0000-0000000000a1','ops_pic') not like '%01%', 'final rejection never actionable');
select pg_temp.ok(pg_temp.q('00000000-0000-0000-0000-0000000000c1','fte_mm') = '06', 'fte_mm: REQUESTED');
select pg_temp.ok(pg_temp.q('00000000-0000-0000-0000-0000000000d1','doc_officer') = '04', 'doc officer: DOCKING without driver');

-- Keyset pagination: no gaps/duplicates across pages of 2 for fte_ops
select pg_temp.ok((select string_agg(right(id::text,2), ',' order by created_at desc, id desc) from (
  select * from queue_requests('00000000-0000-0000-0000-0000000000b1','fte_ops',1)) s) = '08', 'page 1');
select pg_temp.ok((select string_agg(right(id::text,2), ',') from queue_requests('00000000-0000-0000-0000-0000000000b1','fte_ops',1,
  (select created_at from requests where id='11111111-1111-1111-1111-111111111108'), '11111111-1111-1111-1111-111111111108')) = '03', 'page 2 resumes after cursor');
select pg_temp.ok((select count(*) from queue_requests('00000000-0000-0000-0000-0000000000b1','fte_ops',100000)) <= 100, 'server-side max page size');

-- RLS as browser roles ---------------------------------------------------
select set_config('request.jwt.claim.sub', :'a1', false);
set role authenticated;
select pg_temp.ok(pg_temp.n('requests') = 7, 'ops_pic a1 sees only own requests (' || pg_temp.n('requests') || ')');
select pg_temp.ok(pg_temp.n('request_events') >= 1 and not exists (select 1 from request_events where request_id = '11111111-1111-1111-1111-111111111102'), 'events follow request visibility');
select pg_temp.fails($$insert into requests (cluster,region,dock_no,backlogs,truck_size,truck_type,created_by,creator_role) values ('c','r','d',1,'4W','DRYLEASE','00000000-0000-0000-0000-0000000000a1','ops_pic')$$, 'browser cannot insert requests');
select pg_temp.fails($$update requests set status='DOCKED'$$, 'browser cannot update requests');
select pg_temp.fails($$select count(*) from workflow_outbox$$, 'server-only table denied');
select pg_temp.fails($$select count(*) from idempotency_keys$$, 'idempotency table denied');
select pg_temp.fails($$select count(*) from seatalk_callback_events$$, 'callback table denied');
select pg_temp.fails($$select kpi_summary('2026-10-01','2026-10-31')$$, 'KPI denied without reporting permission');
select pg_temp.fails($$select commit_transition('{}'::jsonb, null, '{}'::jsonb)$$, 'workflow RPC denied to browsers');
select pg_temp.ok(pg_temp.n('intraday_dispatch') >= 0, 'ops_pic may read intraday dispatch (HUB-5)');
reset role;

select set_config('request.jwt.claim.sub', :'b1', false);
set role authenticated;
select pg_temp.ok(pg_temp.n('requests') = 9, 'fte_ops sees all requests');
reset role;

-- pending / disabled / anonymous accounts: no operational access
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', false);
set role authenticated;
select pg_temp.ok(pg_temp.n('requests') = 0 and pg_temp.n('clusters') = 0 and pg_temp.n('notifications') = 0 and pg_temp.n('intraday_dispatch') = 0, 'PENDING_APPROVAL has no access');
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', false);
update profiles set account_status = 'DISABLED' where id = '00000000-0000-0000-0000-0000000000b2';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b2', false);
set role authenticated;
select pg_temp.ok(pg_temp.n('requests') = 0, 'disabled user loses access immediately (OPS-3)');
reset role;
update profiles set account_status = 'ACTIVE' where id = '00000000-0000-0000-0000-0000000000b2';
select set_config('request.jwt.claim.sub', '', false);
set role anon;
select pg_temp.fails($$select count(*) from requests$$, 'anon denied');
reset role;

-- reporting permission is independent of operational role (KPI-6)
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000d1', false);
set role authenticated;
select pg_temp.fails($$select kpi_daily('2026-10-01','2026-10-31')$$, 'doc officer without permission denied');
reset role;
