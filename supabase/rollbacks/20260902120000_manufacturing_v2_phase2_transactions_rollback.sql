-- Roll back Phase 2 transaction services while preserving every Phase 1 record.
begin;

drop function if exists public.close_mfg_work_order(bigint,bigint,text);
drop function if exists public.complete_mfg_work_order(bigint,bigint,text);
drop function if exists public.record_mfg_progress(bigint,bigint,bigint,text,text,numeric,jsonb,text,text);
drop function if exists public.assign_mfg_machine(bigint,bigint,text,text);
drop function if exists public.transition_mfg_work_order(bigint,bigint,text,text);
drop function if exists public.mfg_apply_inventory_movement(bigint,bigint,bigint,bigint,bigint,bigint,numeric,text,text,text,boolean);

drop index if exists public.mfg_finished_events_completion_idx;
drop index if exists public.mfg_consumption_events_completion_idx;
drop index if exists public.mfg_completion_events_line_time_idx;

alter table public.mfg_component_consumption_events drop constraint if exists mfg_component_consumption_type_check;
alter table public.mfg_component_consumption_events drop column if exists reason;
alter table public.mfg_component_consumption_events drop column if exists consumption_type;
alter table public.mfg_completion_events drop constraint if exists mfg_completion_source_bucket_check;
alter table public.mfg_completion_events drop constraint if exists mfg_completion_event_type_check;
alter table public.mfg_completion_events drop column if exists result_payload;
alter table public.mfg_completion_events drop column if exists source_bucket;
alter table public.mfg_completion_events drop column if exists event_type;
alter table public.mfg_work_orders drop column if exists closed_by;
alter table public.mfg_work_orders drop column if exists started_by;

alter table public.mfg_work_order_lines drop constraint if exists mfg_work_order_line_disposition_check;
alter table public.mfg_work_order_lines drop column if exists remaining_quantity;
alter table public.mfg_work_order_lines add column remaining_quantity numeric generated always as
  (greatest(planned_quantity-good_quantity-rejected_quantity-scrap_quantity,0)) stored;
alter table public.mfg_work_order_lines add constraint mfg_work_order_lines_check
  check (good_quantity+rejected_quantity+scrap_quantity<=planned_quantity);

delete from public.mfg_role_permissions where permission like 'manufacturing_%';
delete from public.mfg_user_permission_overrides where permission like 'manufacturing_%';
alter table public.mfg_role_permissions drop constraint if exists mfg_role_permissions_permission_check;
alter table public.mfg_user_permission_overrides drop constraint if exists mfg_user_permission_overrides_permission_check;
alter table public.mfg_role_permissions add constraint mfg_role_permissions_permission_check check (permission in (
  'draft_create','release','machine_assign','start_pause','partial_complete','scrap_rework',
  'shortage_override','cancel','close','bom_admin','cost_admin'
));
alter table public.mfg_user_permission_overrides add constraint mfg_user_permission_overrides_permission_check check (permission in (
  'draft_create','release','machine_assign','start_pause','partial_complete','scrap_rework',
  'shortage_override','cancel','close','bom_admin','cost_admin'
));

create or replace function public.mfg_actor_can(p_actor_user_id bigint,p_permission text)
returns boolean language sql stable security invoker set search_path='pg_catalog','public' as $$
  select coalesce(
    (select o.allowed from public.mfg_user_permission_overrides o where o.user_id=p_actor_user_id and o.permission=p_permission),
    (select rp.allowed from public.app_users u join public.mfg_role_permissions rp on rp.role=u.role and rp.permission=p_permission
      where u.id=p_actor_user_id and u.active),false
  )
$$;

create or replace function public.cancel_mfg_work_order(
  p_actor_user_id bigint,p_work_order_id bigint,p_reason text,p_idempotency_key text
) returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare v_wo public.mfg_work_orders%rowtype;
begin
  if not public.mfg_actor_can(p_actor_user_id,'cancel') then raise exception 'manufacturing_permission_denied:cancel'; end if;
  if nullif(btrim(coalesce(p_reason,'')),'') is null then raise exception 'cancellation_reason_required'; end if;
  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is null then raise exception 'idempotency_key_required'; end if;
  select * into v_wo from public.mfg_work_orders where id=p_work_order_id for update;
  if not found then raise exception 'work_order_not_found'; end if;
  if v_wo.status='Cancelled' and v_wo.cancellation_idempotency_key=p_idempotency_key then
    return jsonb_build_object('alreadyCancelled',true,'workOrderId',v_wo.id);
  end if;
  if v_wo.status in ('In Production','Paused','Partially Completed') then raise exception 'started_work_requires_controlled_close'; end if;
  if v_wo.status in ('Completed','Closed') then raise exception 'completed_production_cannot_be_cancelled'; end if;
  if v_wo.status not in ('Draft','Released') then raise exception 'work_order_cannot_be_cancelled'; end if;
  if v_wo.status='Released' then
    update public.mfg_component_allocations set released_quantity=allocated_quantity-consumed_quantity,status='released',released_at=now()
    where work_order_id=v_wo.id and status in ('active','partially_consumed');
    update public.mfg_planned_transfers set status='cancelled',updated_at=now() where work_order_id=v_wo.id and status='planned';
  end if;
  update public.mfg_work_orders set status='Cancelled',cancelled_by=p_actor_user_id,cancelled_at=now(),
    cancellation_reason=btrim(p_reason),cancellation_idempotency_key=p_idempotency_key,updated_at=now() where id=v_wo.id;
  insert into public.mfg_status_history(work_order_id,from_status,to_status,reason,changed_by,idempotency_key)
  values(v_wo.id,v_wo.status,'Cancelled',btrim(p_reason),p_actor_user_id,p_idempotency_key||':status:cancelled');
  insert into public.mfg_audit_events(work_order_id,event_type,actor_user_id,idempotency_key,details)
  values(v_wo.id,'cancelled',p_actor_user_id,p_idempotency_key||':audit:cancelled',
    jsonb_build_object('previousStatus',v_wo.status,'reason',btrim(p_reason),'inventoryQuantityEffect',false));
  return jsonb_build_object('alreadyCancelled',false,'workOrderId',v_wo.id,'previousStatus',v_wo.status);
end $$;
revoke all on function public.cancel_mfg_work_order(bigint,bigint,text,text) from public,anon,authenticated;
grant execute on function public.cancel_mfg_work_order(bigint,bigint,text,text) to service_role;

commit;
