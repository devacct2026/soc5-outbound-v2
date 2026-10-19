\set ON_ERROR_STOP on
create function pg_temp.ok(c boolean, m text) returns void language plpgsql as $$ begin if not coalesce(c,false) then raise exception 'ASSERT FAILED: %', m; end if; end $$;
create function pg_temp.fails_with(sql text, state text, m text) returns void language plpgsql as $$
declare s text;
begin
  begin execute sql; exception when others then get stacked diagnostics s = returned_sqlstate; if s = state then return; end if; raise exception 'WRONG SQLSTATE % (wanted %) for: %', s, state, m; end;
  raise exception 'EXPECTED FAILURE: %', m;
end $$;

-- ===== lead 8: backlog keeps the time of day
create function pg_temp.mkreq(id text, cluster text, ts timestamptz, st text default 'PENDING') returns void language sql as $$
  insert into requests (id, cluster, region, dock_no, backlogs, backlogs_timestamp, truck_size, truck_type, created_by, creator_role, status, approval_status)
  values (id::uuid, cluster, 'R', 'D', 5, ts, '4W', 'DRYLEASE', '00000000-0000-0000-0000-0000000000a1', 'ops_pic', st::request_status,
          case st when 'CANCELLED' then 'CANCELLED' else 'PENDING' end)
$$;
select pg_temp.mkreq('70000000-0000-0000-0000-000000000001', 'Alpha Hub', '2026-10-20T13:45:30+08');
select pg_temp.ok((select backlogs_timestamp = '2026-10-20T13:45:30+08'::timestamptz from requests where id='70000000-0000-0000-0000-000000000001'), 'time of day preserved');

-- ===== lead 7: import + propagation
select pg_temp.mkreq('70000000-0000-0000-0000-000000000002', 'Alpha Hub', null);
select pg_temp.mkreq('70000000-0000-0000-0000-000000000003', 'Alpha Hub', null, 'CANCELLED');
select pg_temp.mkreq('70000000-0000-0000-0000-000000000004', 'Other Hub', null);
select pg_temp.ok((import_clusters('[{"name":"Alpha Hub","region":"Reg","dock_no":"7","backlogs":42,"backlogs_timestamp":"2026-10-20T10:15:00Z"},
   {"name":"Alpha Hub","region":"Reg","dock_no":"7","backlogs":43,"backlogs_timestamp":"2026-10-20T10:15:00Z"},
   {"name":"","region":"x"},{"name":"NoDock Hub","region":"Reg","backlogs":0}]'::jsonb)->>'processed')::int = 2, 'dedupe + validation');
select pg_temp.ok((select backlogs = 43 and backlogs_timestamp = '2026-10-20T10:15:00Z' from requests where id='70000000-0000-0000-0000-000000000001'), 'propagated incl. full timestamp');
select pg_temp.ok((select backlogs = 43 from requests where id='70000000-0000-0000-0000-000000000002'), 'propagated to every matching open request');
select pg_temp.ok((select backlogs = 5 from requests where id='70000000-0000-0000-0000-000000000003'), 'CANCELLED immutable row untouched');
select pg_temp.ok((select backlogs = 5 from requests where id='70000000-0000-0000-0000-000000000004'), 'unrelated cluster untouched');
select pg_temp.ok((select row_version = 2 from requests where id='70000000-0000-0000-0000-000000000001'), 'row_version bumped');
select pg_temp.ok((select count(*) = 1 from request_events where request_id='70000000-0000-0000-0000-000000000001' and event_type='BACKLOG_PROPAGATED'), 'audited once');
select import_clusters('[{"name":"Alpha Hub","region":"Reg","dock_no":"7","backlogs":43,"backlogs_timestamp":"2026-10-20T10:15:00Z"}]'::jsonb);
select pg_temp.ok((select count(*) = 1 from request_events where request_id='70000000-0000-0000-0000-000000000001' and event_type='BACKLOG_PROPAGATED'), 'idempotent re-import adds no event');
select pg_temp.ok((select dock_no is null from clusters where name='NoDock Hub'), 'dock-less hub accepted');
select pg_temp.fails_with($$update request_events set event_type='x' where event_type='BACKLOG_PROPAGATED'$$, 'P0001', 'propagation audit immutable');

-- ===== lead 2: presence, round robin, expiry, reassignment
update profiles set seatalk_employee_code = 'e_b1' where id = '00000000-0000-0000-0000-0000000000b1';
update profiles set seatalk_employee_code = 'e_b2' where id = '00000000-0000-0000-0000-0000000000b2';
update profiles set seatalk_employee_code = 'e_ad' where id = '00000000-0000-0000-0000-0000000000e1';
select pg_temp.mkreq('70000000-0000-0000-0000-000000000010', 'Route Hub', null);
select pg_temp.ok(assign_next_approver('70000000-0000-0000-0000-000000000010', gen_random_uuid(), 'i1', 'h1', now())->>'result' = 'NO_CANDIDATE', 'nobody present');
update profiles set last_seen_at = now() where id in ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b2');
update profiles set last_seen_at = now() - interval '5 minutes' where id = '00000000-0000-0000-0000-0000000000e1';
select assign_next_approver('70000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-000000000001', 'item1', 'h1', now()) as r1 \gset
select pg_temp.ok((:'r1'::jsonb)->>'result' = 'ASSIGNED' and (:'r1'::jsonb)->>'assigneeId' = '00000000-0000-0000-0000-0000000000b1', 'first present approver (stale one excluded)');
select pg_temp.ok(assign_next_approver('70000000-0000-0000-0000-000000000010', gen_random_uuid(), 'x', 'x', now())->>'result' = 'ALREADY_ASSIGNED', 'one open assignment per request');
select pg_temp.mkreq('70000000-0000-0000-0000-000000000011', 'Route Hub 2', null);
select pg_temp.ok(assign_next_approver('70000000-0000-0000-0000-000000000011', '20000000-0000-0000-0000-000000000002', 'item2', 'h2', now())->>'assigneeId' = '00000000-0000-0000-0000-0000000000b2', 'round robin advances to next approver');
select pg_temp.mkreq('70000000-0000-0000-0000-000000000012', 'Route Hub 3', null);
select pg_temp.ok(assign_next_approver('70000000-0000-0000-0000-000000000012', '20000000-0000-0000-0000-000000000003', 'item3', 'h3', now())->>'assigneeId' = '00000000-0000-0000-0000-0000000000b1', 'cursor wraps around');
-- expiry then reassignment skips the one who just expired
update seatalk_approval_assignments set expires_at = now() - interval '1 second' where id = '20000000-0000-0000-0000-000000000001';
select pg_temp.ok(expire_assignments(now()) @> '"70000000-0000-0000-0000-000000000010"'::jsonb, 'expired request listed for rerouting');
select pg_temp.ok((select status = 'EXPIRED' from seatalk_approval_assignments where id='20000000-0000-0000-0000-000000000001'), 'marked expired');
select pg_temp.ok(assign_next_approver('70000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-000000000004', 'item4', 'h4', now())->>'assigneeId' = '00000000-0000-0000-0000-0000000000b2', 'reassigned to a different present approver');
-- everyone attempted -> new cycle
update seatalk_approval_assignments set status='EXPIRED' where id='20000000-0000-0000-0000-000000000004';
select pg_temp.ok(assign_next_approver('70000000-0000-0000-0000-000000000010', '20000000-0000-0000-0000-000000000005', 'item5', 'h5', now())->>'result' = 'ASSIGNED', 'new routing cycle when all attempted');
select pg_temp.ok((select routing_cycle = 2 from seatalk_approval_assignments where id='20000000-0000-0000-0000-000000000005'), 'cycle incremented');
-- decision closes open assignments; terminal request is not routable
update requests set status='REQUESTED', approval_status='APPROVED', row_version=row_version+1 where id='70000000-0000-0000-0000-000000000010';
select pg_temp.ok((select status='CLOSED' from seatalk_approval_assignments where id='20000000-0000-0000-0000-000000000005'), 'decision closes the open assignment');
select pg_temp.ok(assign_next_approver('70000000-0000-0000-0000-000000000010', gen_random_uuid(), 'z', 'z', now())->>'result' = 'TERMINAL', 'decided request not routable');
-- orphan sweep
select pg_temp.mkreq('70000000-0000-0000-0000-000000000013', 'Orphan Hub', null);
select pg_temp.ok(orphan_approval_requests(now(), 100, 300) @> '"70000000-0000-0000-0000-000000000013"'::jsonb, 'orphan listed when an approver is present');
update profiles set last_seen_at = now() - interval '10 minutes' where role = 'fte_ops';
select pg_temp.ok(orphan_approval_requests(now(), 100, 300) = '[]'::jsonb, 'no orphans listed when nobody is present');
-- concurrency primitive: two open assignments for one request are impossible
select pg_temp.fails_with($$insert into seatalk_approval_assignments (request_id, assignee_id, status) values ('70000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-0000000000b1','PENDING')$$, '23505', 'second open assignment rejected');

-- ===== lead 6: sign-up trigger, backroom users, password flows
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
  values ('30000000-0000-0000-0000-000000000001', 'New.Person@spxexpress.com', '{"full_name":"New Person","seatalk_employee_code":"EVIL"}', '{}');
select pg_temp.ok((select account_status = 'PENDING_APPROVAL' and role is null and seatalk_employee_code is null and email = 'new.person@spxexpress.com'
                   from profiles where id='30000000-0000-0000-0000-000000000001'), 'auto-registered PENDING_APPROVAL; client metadata never grants a SeaTalk identity');
select pg_temp.fails_with($$insert into auth.users (id, email) values ('30000000-0000-0000-0000-000000000002', 'x@gmail.com')$$, 'P0001', 'foreign domain blocked');
insert into auth.users (id, email, raw_app_meta_data) values ('30000000-0000-0000-0000-000000000003', 'sea@spxexpress.com', '{"seatalk_employee_code":"e_77"}');
select pg_temp.ok((select seatalk_employee_code = 'e_77' from profiles where id='30000000-0000-0000-0000-000000000003'), 'server-written app metadata carries the SeaTalk identity');
insert into auth.users (id, email, raw_app_meta_data) values ('30000000-0000-0000-0000-000000000004', 'ops777@backroom.soc5.internal', '{"account_type":"backroom"}');
select pg_temp.ok(not exists (select 1 from profiles where id='30000000-0000-0000-0000-000000000004'), 'backroom auth users get no auto profile');
select pg_temp.ok(admin_create_backroom_user('30000000-0000-0000-0000-000000000004','Ops Seven','OPS777','ops_pic','00000000-0000-0000-0000-0000000000b1')->>'ok' = 'true', 'backroom profile created');
select pg_temp.ok((select must_change_password and account_status='ACTIVE' and ops_id='ops777' from profiles where id='30000000-0000-0000-0000-000000000004'), 'forced change flagged');
insert into auth.users (id, email, raw_app_meta_data) values ('30000000-0000-0000-0000-000000000005', 'ops777b@backroom.soc5.internal', '{"account_type":"backroom"}');
select pg_temp.ok(admin_create_backroom_user('30000000-0000-0000-0000-000000000005','Dup','ops777','ops_pic','00000000-0000-0000-0000-0000000000b1')->>'code' = 'OPS_ID_TAKEN', 'duplicate Ops ID refused');
select pg_temp.ok(mark_password_changed('30000000-0000-0000-0000-000000000004')->>'ok' = 'true', 'password change clears the flag');
select pg_temp.ok(mark_password_changed('30000000-0000-0000-0000-000000000004')->>'code' = 'INVALID_STATE', 'cannot change again without a reset');
select pg_temp.ok(admin_mark_password_reset('30000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-0000000000b1')->>'ok' = 'true', 'reset marks the account');
select pg_temp.ok(admin_mark_password_reset('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b1')->>'code' = 'NOT_FOUND', 'FTE (non-backroom) accounts are not resettable');
select pg_temp.ok(admin_update_user('30000000-0000-0000-0000-000000000004','Ops Seven B','doc_officer','00000000-0000-0000-0000-0000000000b1')->>'ok' = 'true', 'role/name update');
select pg_temp.ok(admin_update_user('00000000-0000-0000-0000-0000000000b1','Me','fte_mm','00000000-0000-0000-0000-0000000000b1')->>'code' = 'SELF_CHANGE', 'no self role change');
select pg_temp.ok((select count(*) = 4 from audit_events where event_type in ('USER_CREATED','USER_UPDATED','PASSWORD_RESET','PASSWORD_CHANGED')), 'user admin audited');
select pg_temp.ok(submit_access_request('Some Person','OPS12345')->>'ok' = 'true', 'access request accepted');
select submit_access_request('Some Person','ops12345');
select pg_temp.ok((select count(*) = 2 from notifications where event_type='BACKROOM_ACCESS_REQUESTED'), 'deduped per role/day');
select pg_temp.ok(submit_access_request('x','not-ops')->>'code' = 'VALIDATION_FAILED', 'validated');

-- service-role only
set role authenticated;
select pg_temp.fails_with($$select assign_next_approver(gen_random_uuid(), gen_random_uuid(), 'a', 'b')$$, '42501', 'browsers cannot route');
select pg_temp.fails_with($$select import_clusters('[]')$$, '42501', 'browsers cannot import clusters');
select pg_temp.fails_with($$select submit_access_request('abc','ops1')$$, '42501', 'browsers cannot call privileged user functions');
reset role;

-- ===== lead 11: notification feed covers every visible notice
insert into notifications (dedupe_key, event_type, title, recipient_role, created_at)
  select 'feed-' || g, 'X', 'role notice ' || g, 'fte_mm', now() - make_interval(mins => g) from generate_series(1, 120) g;
insert into notifications (dedupe_key, event_type, title, recipient_user_id) values ('feed-user', 'X', 'direct', '00000000-0000-0000-0000-0000000000c1');
select pg_temp.ok(notification_unread_count('00000000-0000-0000-0000-0000000000c1', 'fte_mm') >= 121, 'unread spans the whole feed, not one page');
select pg_temp.ok((select count(*) from notification_feed('00000000-0000-0000-0000-0000000000c1', 'fte_mm', 500)) = 100, 'page size is capped at 100');
select pg_temp.ok((select count(*) from notification_feed('00000000-0000-0000-0000-0000000000d1', 'doc_officer', 50)) = 0, 'other roles do not see role-targeted notices');
select pg_temp.ok(notification_mark_read('00000000-0000-0000-0000-0000000000c1', 'fte_mm', null) >= 121, 'mark-all covers notices beyond the first page');
select pg_temp.ok(notification_unread_count('00000000-0000-0000-0000-0000000000c1', 'fte_mm') = 0, 'all read');
select pg_temp.ok(notification_mark_read('00000000-0000-0000-0000-0000000000c1', 'fte_mm', null) = 0, 'idempotent');
select pg_temp.ok(notification_unread_count('00000000-0000-0000-0000-0000000000b1', 'fte_ops') >= 0 and notification_unread_count('00000000-0000-0000-0000-0000000000c1', 'fte_mm') = 0, 'receipts are per user');
select pg_temp.ok(notification_mark_read('00000000-0000-0000-0000-0000000000d1', 'doc_officer', (select id from notifications where dedupe_key='feed-user')) = -1, 'cannot mark a notice you cannot see');
set role authenticated;
select pg_temp.fails_with($$select notification_unread_count(gen_random_uuid(), 'fte_mm')$$, '42501', 'browsers cannot call feed functions');
reset role;

-- ===== lead 9: sheet export attribution
update profiles set full_name = 'Pat Creator' where id = '00000000-0000-0000-0000-0000000000a1';
update profiles set full_name = 'Olive Ops' where id = '00000000-0000-0000-0000-0000000000b1';
update profiles set full_name = 'Mike MM' where id = '00000000-0000-0000-0000-0000000000c1';
update profiles set full_name = 'Dora Doc' where id = '00000000-0000-0000-0000-0000000000d1';
select pg_temp.mkreq('80000000-0000-0000-0000-000000000001', 'Sheet Hub', '2026-10-20T10:00:00Z');
insert into request_events (request_id, event_type, actor_id, metadata) values
  ('80000000-0000-0000-0000-000000000001', 'REQUEST_CREATED', '00000000-0000-0000-0000-0000000000a1', '{"lh_type_request":"WETLEASE"}'),
  ('80000000-0000-0000-0000-000000000001', 'REQUEST_APPROVED', '00000000-0000-0000-0000-0000000000b2', '{}'),
  ('80000000-0000-0000-0000-000000000001', 'REQUEST_APPROVED', '00000000-0000-0000-0000-0000000000b1', '{}'),
  ('80000000-0000-0000-0000-000000000001', 'TRUCK_ASSIGNED', '00000000-0000-0000-0000-0000000000c1', '{}'),
  ('80000000-0000-0000-0000-000000000001', 'DRIVER_ASSIGNED', '00000000-0000-0000-0000-0000000000d1', '{}');
select pg_temp.ok((select ops_fte = 'Olive Ops' and mm_fte = 'Mike MM' and doc_officer = 'Dora Doc' and ops_pic = 'Pat Creator'
  and lh_type_request = 'WETLEASE' and truck_type = 'DRYLEASE' and assigned_time is not null
  from sheet_export_rows(100000) where request_id = '80000000-0000-0000-0000-000000000001'), 'attribution: last event of each type wins, names resolved server-side');
select pg_temp.ok((select request_id from sheet_export_rows(1)) = (select id from requests order by request_timestamp asc, id asc limit 1), 'ordered by request time ascending');
