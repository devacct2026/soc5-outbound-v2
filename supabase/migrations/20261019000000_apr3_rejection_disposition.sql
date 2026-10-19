-- APR-3: explicit rejection disposition. NOT applied to any environment;
-- replay only in a disposable non-production database.
-- Assumes requests.rejection_return_role and requests.approval_status exist
-- (20261013032010_linehaul_rejection_routing.sql, 021_approval_center_schema.sql).
-- Those migrations are not in this checkout, so this file is unreplayed.

create type rejection_disposition as enum (
  'FINAL_NO_ROUTE',
  'RETURN_TO_OPS_PIC',
  'RETURN_TO_FTE_OPS',
  'LEGACY_UNRESOLVED'
);

alter table requests
  add column rejection_disposition rejection_disposition;

-- Backfill: never infer finality from a null return role. Rows with a known
-- return role map to the routed disposition; every other REJECTED row is
-- LEGACY_UNRESOLVED (read-only, manual review). Original values are preserved.
update requests set rejection_disposition = case
  when rejection_return_role::text = 'ops_pic' then 'RETURN_TO_OPS_PIC'::rejection_disposition
  when rejection_return_role::text = 'fte_ops' then 'RETURN_TO_FTE_OPS'::rejection_disposition
  else 'LEGACY_UNRESOLVED'::rejection_disposition
end
where status::text = 'REJECTED';

-- Added NOT VALID so legacy rows do not block the migration. Validate after
-- reconciling any rows the backfill could not satisfy:
--   alter table requests validate constraint requests_rejection_disposition_consistent;
alter table requests
  add constraint requests_rejection_disposition_consistent check (
    (status::text <> 'REJECTED'
      and rejection_disposition is null
      and rejection_return_role is null)
    or (status::text = 'REJECTED' and (
      (rejection_disposition = 'FINAL_NO_ROUTE'
        and approval_status = 'REJECTED' and rejection_return_role is null)
      or (rejection_disposition = 'RETURN_TO_OPS_PIC'
        and approval_status = 'REJECTED' and rejection_return_role::text = 'ops_pic')
      or (rejection_disposition = 'RETURN_TO_FTE_OPS'
        and approval_status = 'REJECTED' and rejection_return_role::text = 'fte_ops')
      or (rejection_disposition = 'LEGACY_UNRESOLVED'
        and rejection_return_role is null)
    ))
  ) not valid;

-- Queue/mutation predicates must use the disposition. Actionable rejected rows:
--   status = 'REJECTED' and rejection_disposition in
--   ('RETURN_TO_OPS_PIC','RETURN_TO_FTE_OPS')
-- FINAL_NO_ROUTE and LEGACY_UNRESOLVED remain visible in authorized history only.

-- Append-only audit: reject UPDATE/DELETE on request_events.
create or replace function request_events_immutable() returns trigger
language plpgsql as $fn$
begin
  raise exception 'request_events is append-only';
end
$fn$;

create trigger request_events_no_update_delete
  before update or delete on request_events
  for each row execute function request_events_immutable();
