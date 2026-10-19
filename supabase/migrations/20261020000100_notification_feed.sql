-- SOC5 Outbound v2: notification feed (lead 11). Unread counts and "mark all read" must cover EVERY visible
-- notification, not just the newest page, and role-wide notices follow current role membership (NOT-2).
-- Disposable replay only.

create or replace function notification_feed(p_user uuid, p_role user_role, p_limit integer default 50,
  p_before timestamptz default null)
returns table (id uuid, event_type text, title text, body text, request_id uuid, created_at timestamptz, read boolean)
language sql stable security definer set search_path = public as $fn$
  select n.id, n.event_type, n.title, n.body, n.request_id, n.created_at, (r.notification_id is not null) as read
  from notifications n
  left join notification_reads r on r.notification_id = n.id and r.user_id = p_user
  where (n.recipient_user_id = p_user or n.recipient_role = p_role)
    and (p_before is null or n.created_at < p_before)
  order by n.created_at desc, n.id desc
  limit least(greatest(p_limit, 1), 100)
$fn$;

create or replace function notification_unread_count(p_user uuid, p_role user_role) returns integer
language sql stable security definer set search_path = public as $fn$
  select count(*)::integer from notifications n
  where (n.recipient_user_id = p_user or n.recipient_role = p_role)
    and not exists (select 1 from notification_reads r where r.notification_id = n.id and r.user_id = p_user)
$fn$;

-- p_id null = all visible; returns rows newly marked, or -1 when p_id is not visible to this user.
create or replace function notification_mark_read(p_user uuid, p_role user_role, p_id uuid default null) returns integer
language plpgsql security definer set search_path = public as $fn$
declare n integer;
begin
  if p_id is not null and not exists (
      select 1 from notifications x where x.id = p_id and (x.recipient_user_id = p_user or x.recipient_role = p_role)) then
    return -1;
  end if;
  insert into notification_reads (notification_id, user_id)
  select x.id, p_user from notifications x
  where (x.recipient_user_id = p_user or x.recipient_role = p_role) and (p_id is null or x.id = p_id)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end
$fn$;

revoke execute on function notification_feed, notification_unread_count, notification_mark_read from public, anon, authenticated;
grant execute on function notification_feed, notification_unread_count, notification_mark_read to service_role;
