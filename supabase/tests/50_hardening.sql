\set ON_ERROR_STOP on
create function pg_temp.ok(c boolean, m text) returns void language plpgsql as $$ begin if not coalesce(c,false) then raise exception 'ASSERT FAILED: %', m; end if; end $$;
create function pg_temp.fails_with(sql text, state text, m text) returns void language plpgsql as $$
declare s text;
begin
  begin execute sql; exception when others then get stacked diagnostics s = returned_sqlstate; if s = state then return; end if; raise exception 'WRONG SQLSTATE % (wanted %) for: %', s, state, m; end;
  raise exception 'EXPECTED FAILURE: %', m;
end $$;
\set pic '00000000-0000-0000-0000-0000000000a1'
\set admin '00000000-0000-0000-0000-0000000000e1'

-- Idempotency (OPS-4): live key => abort (unique_violation, caller replays); expired key => recycled
create function pg_temp.mk(id text, key text) returns jsonb language sql as $$
  select commit_transition(
    jsonb_build_object('id', id, 'cluster','C','region','R','dock_no','D','backlogs',1,'truck_size','4W','truck_type','DRYLEASE',
      'created_by','00000000-0000-0000-0000-0000000000a1','creator_role','ops_pic','status','PENDING','approval_status','PENDING',
      'approval_version',1,'approval_correlation_id', gen_random_uuid(),'submitted_at', now(),'request_timestamp', now(),'created_at', now(),'updated_at', now(),'row_version',1),
    null, '{"event_type":"REQUEST_CREATED"}'::jsonb, '[]'::jsonb, '[]'::jsonb,
    jsonb_build_object('actor_id','00000000-0000-0000-0000-0000000000a1','method','POST','path','/p','key', key,'payload_hash','h','response_status',201,'response_body','{}'::jsonb))
$$;
select pg_temp.ok((pg_temp.mk('66666666-6666-6666-6666-666666666601','idem-key-aaaa')->>'ok')::boolean, 'first create');
select pg_temp.fails_with($$select pg_temp.mk('66666666-6666-6666-6666-666666666602','idem-key-aaaa')$$, '23505', 'live key reuse aborts atomically');
select pg_temp.ok(not exists (select 1 from requests where id='66666666-6666-6666-6666-666666666602'), 'aborted create left no row');
update idempotency_keys set expires_at = now() - interval '1 minute' where key='idem-key-aaaa';
select pg_temp.ok((pg_temp.mk('66666666-6666-6666-6666-666666666603','idem-key-aaaa')->>'ok')::boolean, 'expired key is recycled (no 409 until purge)');
select pg_temp.ok((select expires_at > now() from idempotency_keys where key='idem-key-aaaa'), 'recycled key has a fresh 24h window');

-- Terminal-row guard (defence in depth)
select pg_temp.fails_with($$update requests set backlogs = 9 where id = '11111111-1111-1111-1111-111111111101'$$, '23514', 'FINAL_NO_ROUTE immutable');
select pg_temp.fails_with($$update requests set status='PENDING', approval_status='PENDING', rejection_disposition=null where id = '11111111-1111-1111-1111-111111111101'$$, '23514', 'FINAL_NO_ROUTE cannot be reactivated');
select pg_temp.fails_with($$update requests set backlogs = 9 where id = '11111111-1111-1111-1111-111111111109'$$, '23514', 'LEGACY_UNRESOLVED needs manual reconciliation');
begin;
select set_config('soc5.legacy_resolution', 'on', true);
update requests set backlogs = 9 where id = '11111111-1111-1111-1111-111111111109';
commit;
select pg_temp.ok((select backlogs from requests where id='11111111-1111-1111-1111-111111111109') = 9, 'explicit reconciliation session may resolve legacy rows');
update requests set status='CANCELLED', approval_status='CANCELLED' where id='66666666-6666-6666-6666-666666666601';
select pg_temp.fails_with($$update requests set status='PENDING', approval_status='PENDING' where id='66666666-6666-6666-6666-666666666601'$$, '23514', 'CANCELLED terminal');

-- status / approval_status pairs (ST-8)
select pg_temp.fails_with($$update requests set status='REQUESTED' where id='66666666-6666-6666-6666-666666666603'$$, '23514', 'REQUESTED with approval PENDING');

-- Admin guards: no self-lockout, never the last admin
select pg_temp.ok((admin_disable_account(:'admin', :'admin', 'bye')->>'code') = 'INVALID_STATE', 'cannot disable yourself');
alter table auth.users disable trigger on_auth_user_created;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000e2', 'admin2@test');
alter table auth.users enable trigger on_auth_user_created;
insert into profiles (id, role, email, account_status, is_admin) values ('00000000-0000-0000-0000-0000000000e2', 'fte_ops', 'admin2@test', 'ACTIVE', true);
select pg_temp.ok((admin_disable_account('00000000-0000-0000-0000-0000000000e2', :'admin', 'rotate admins')->>'ok')::boolean, 'a second admin can be disabled while another remains');
select pg_temp.ok((admin_disable_account(:'admin', '00000000-0000-0000-0000-0000000000e2', 'x')->>'code') = 'FORBIDDEN', 'disabled admin has no authority');
update profiles set account_status='ACTIVE' where id='00000000-0000-0000-0000-0000000000e2';
update profiles set is_admin=false where id='00000000-0000-0000-0000-0000000000e1';
select pg_temp.ok((admin_disable_account('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000e2', 'x')->>'code') = 'INVALID_STATE', 'self-disable still blocked');
update profiles set is_admin=true where id='00000000-0000-0000-0000-0000000000e1';

-- Profiles: privilege flags are not readable by browsers (column-level grant)
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', false);
set role authenticated;
select pg_temp.ok((select count(*) from profiles) >= 1, 'fte_ops can read directory columns');
select pg_temp.fails_with($$select is_admin from profiles$$, '42501', 'is_admin hidden');
select pg_temp.fails_with($$select reporting_permission from profiles$$, '42501', 'reporting_permission hidden');
select pg_temp.fails_with($$select seatalk_employee_code from profiles$$, '42501', 'employee code hidden');
select pg_temp.fails_with($$select * from profiles$$, '42501', 'select * denied (includes hidden columns)');
reset role;
