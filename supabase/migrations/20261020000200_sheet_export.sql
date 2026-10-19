-- SOC5 Outbound v2: Google Sheets export rows (lead 9). One server-side join so attribution (who approved,
-- who assigned the truck, which Doc Officer assigned the driver, who created) is computed in the database,
-- never trusted from the client. Mirrors the original sync's "last event of a type wins" rule.
create or replace function sheet_export_rows(p_limit integer default 50001)
returns table (
  request_id uuid, request_timestamp timestamptz, cluster text, region text, dock_no text, backlogs integer,
  backlogs_timestamp timestamptz, lh_type_request text, ops_fte text, plate_number text, mm_fte text, truck_size text,
  truck_type text, provide_time timestamptz, linehaul_trip_no text, assigned_time timestamptz, docked_at timestamptz,
  doc_officer text, ops_pic text, status text)
language sql stable security definer set search_path = public as $fn$
  select r.id, r.request_timestamp, r.cluster, r.region, r.dock_no, r.backlogs, r.backlogs_timestamp,
    coalesce((select e.metadata ->> 'lh_type_request' from request_events e
               where e.request_id = r.id and e.event_type = 'REQUEST_CREATED' order by e.id desc limit 1), r.truck_type::text),
    (select nullif(p.full_name, '') from request_events e join profiles p on p.id = e.actor_id
      where e.request_id = r.id and e.event_type = 'REQUEST_APPROVED' order by e.id desc limit 1),
    r.plate_number,
    (select nullif(p.full_name, '') from request_events e join profiles p on p.id = e.actor_id
      where e.request_id = r.id and e.event_type = 'TRUCK_ASSIGNED' order by e.id desc limit 1),
    r.truck_size::text, r.truck_type::text, r.provide_time, r.linehaul_trip_no,
    (select e.created_at from request_events e where e.request_id = r.id and e.event_type = 'TRUCK_ASSIGNED' order by e.id desc limit 1),
    r.docked_at,
    (select nullif(p.full_name, '') from request_events e join profiles p on p.id = e.actor_id
      where e.request_id = r.id and e.event_type in ('DRIVER_ASSIGNED', 'DRIVER_REASSIGNED', 'REQUEST_CONFIRMED') order by e.id desc limit 1),
    nullif(c.full_name, ''), r.status::text
  from requests r left join profiles c on c.id = r.created_by
  order by r.request_timestamp asc, r.id asc
  limit greatest(p_limit, 1)
$fn$;
revoke execute on function sheet_export_rows from public, anon, authenticated;
grant execute on function sheet_export_rows to service_role;
