-- SOC5 Outbound v2: FTE-run backroom account disable (source parity: FTE Ops/MM manage Ops IDs) with immutable audit.
-- Administrator-run disable of any account stays in admin_disable_account (reason + last-admin guard).
create or replace function fte_disable_backroom_user(p_user uuid, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public as $fn$
begin
  if p_user = p_actor then return jsonb_build_object('ok', false, 'code', 'SELF_CHANGE'); end if;
  update profiles set account_status = 'DISABLED', updated_at = now()
   where id = p_user and ops_id is not null and account_status = 'ACTIVE';
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  insert into audit_events (event_type, actor_id, subject_type, subject_id)
  values ('USER_DISABLED', p_actor, 'profile', p_user::text);
  return jsonb_build_object('ok', true);
end
$fn$;
revoke execute on function fte_disable_backroom_user from public, anon, authenticated;
grant execute on function fte_disable_backroom_user to service_role;
