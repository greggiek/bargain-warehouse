-- Manufacturing V2 Phase 2: granular permissions and transactional production.
-- Backend only. The manufacturing_v2 feature flag remains disabled.

begin;

-- Replace the Phase 1 permission vocabulary with the approved server-side keys.
alter table public.mfg_role_permissions drop constraint if exists mfg_role_permissions_permission_check;
alter table public.mfg_user_permission_overrides drop constraint if exists mfg_user_permission_overrides_permission_check;

alter table public.mfg_role_permissions add constraint mfg_role_permissions_permission_check check (permission in (
  'manufacturing_view_planner','manufacturing_view_work_orders','manufacturing_view_assigned_production',
  'manufacturing_print_packet','manufacturing_create_draft','manufacturing_edit_draft','manufacturing_release',
  'manufacturing_assign_machine','manufacturing_start_pause','manufacturing_record_progress',
  'manufacturing_partial_complete','manufacturing_complete','manufacturing_close','manufacturing_cancel',
  'manufacturing_shortage_override','manufacturing_bom_admin','manufacturing_cost_admin',
  'manufacturing_controlled_reopen','manufacturing_admin_correction',
  'draft_create','release','machine_assign','start_pause','partial_complete','scrap_rework',
  'shortage_override','cancel','close','bom_admin','cost_admin'
));
alter table public.mfg_user_permission_overrides add constraint mfg_user_permission_overrides_permission_check check (permission in (
  'manufacturing_view_planner','manufacturing_view_work_orders','manufacturing_view_assigned_production',
  'manufacturing_print_packet','manufacturing_create_draft','manufacturing_edit_draft','manufacturing_release',
  'manufacturing_assign_machine','manufacturing_start_pause','manufacturing_record_progress',
  'manufacturing_partial_complete','manufacturing_complete','manufacturing_close','manufacturing_cancel',
  'manufacturing_shortage_override','manufacturing_bom_admin','manufacturing_cost_admin',
  'manufacturing_controlled_reopen','manufacturing_admin_correction',
  'draft_create','release','machine_assign','start_pause','partial_complete','scrap_rework',
  'shortage_override','cancel','close','bom_admin','cost_admin'
));

with permissions(permission) as (values
 ('manufacturing_view_planner'),('manufacturing_view_work_orders'),('manufacturing_view_assigned_production'),
 ('manufacturing_print_packet'),('manufacturing_create_draft'),('manufacturing_edit_draft'),
 ('manufacturing_release'),('manufacturing_assign_machine'),('manufacturing_start_pause'),
 ('manufacturing_record_progress'),('manufacturing_partial_complete'),('manufacturing_complete'),
 ('manufacturing_close'),('manufacturing_cancel'),('manufacturing_shortage_override'),
 ('manufacturing_bom_admin'),('manufacturing_cost_admin'),('manufacturing_controlled_reopen'),
 ('manufacturing_admin_correction')
), role_matrix(role,permission,allowed) as (
 select 'admin',permission,true from permissions
 union all
 select 'manager',permission,permission in (
  'manufacturing_view_planner','manufacturing_view_work_orders','manufacturing_view_assigned_production',
  'manufacturing_print_packet','manufacturing_create_draft','manufacturing_edit_draft','manufacturing_release',
  'manufacturing_assign_machine','manufacturing_start_pause','manufacturing_record_progress',
  'manufacturing_partial_complete','manufacturing_complete','manufacturing_close','manufacturing_cancel'
 ) from permissions
 union all
 select 'warehouse',permission,permission in (
  'manufacturing_view_work_orders','manufacturing_view_assigned_production','manufacturing_print_packet'
 ) from permissions
)
insert into public.mfg_role_permissions(role,permission,allowed)
select role,permission,allowed from role_matrix
on conflict(role,permission) do update set allowed=excluded.allowed,updated_at=now();

-- rejected_quantity is the Phase 1 rejected-pending-disposition bucket.
alter table public.mfg_work_order_lines drop constraint if exists mfg_work_order_lines_check;
alter table public.mfg_work_order_lines drop column remaining_quantity;
alter table public.mfg_work_order_lines add column remaining_quantity numeric generated always as
  (planned_quantity-good_quantity-rejected_quantity-rework_quantity-scrap_quantity) stored;
alter table public.mfg_work_order_lines add constraint mfg_work_order_line_disposition_check check (
  good_quantity>=0 and rejected_quantity>=0 and rework_quantity>=0 and scrap_quantity>=0
  and good_quantity+rejected_quantity+rework_quantity+scrap_quantity<=planned_quantity
  and remaining_quantity>=0
);

alter table public.mfg_completion_events add column event_type text;
alter table public.mfg_completion_events add column source_bucket text;
alter table public.mfg_completion_events add column result_payload jsonb not null default '{}'::jsonb;
alter table public.mfg_completion_events add constraint mfg_completion_event_type_check check
  (event_type in ('good','rejected_pending','rework','scrap'));
alter table public.mfg_completion_events add constraint mfg_completion_source_bucket_check check
  (source_bucket in ('unstarted','rejected_pending','rework'));

alter table public.mfg_component_consumption_events add column consumption_type text;
alter table public.mfg_component_consumption_events add column reason text;
alter table public.mfg_component_consumption_events add constraint mfg_component_consumption_type_check check
  (consumption_type in ('standard_attempt','explicit_scrap','rework_additional'));

alter table public.mfg_work_orders add column started_by bigint references public.app_users(id) on delete restrict;
alter table public.mfg_work_orders add column closed_by bigint references public.app_users(id) on delete restrict;

create index mfg_completion_events_line_time_idx on public.mfg_completion_events(work_order_line_id,recorded_at);
create index mfg_consumption_events_completion_idx on public.mfg_component_consumption_events(completion_event_id);
create index mfg_finished_events_completion_idx on public.mfg_finished_inventory_events(completion_event_id);

-- Signed, idempotent local inventory movement. This is not a Shopify operation.
create or replace function public.mfg_apply_inventory_movement(
  p_actor_user_id bigint,p_work_order_id bigint,p_work_order_line_id bigint,p_completion_event_id bigint,
  p_product_id bigint,p_location_id bigint,p_quantity_delta numeric,p_movement_type text,
  p_reason text,p_idempotency_key text,p_allow_negative boolean default false
) returns bigint language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare v_balance public.inventory_balances%rowtype; v_after numeric; v_movement_id bigint; v_user_name text;
begin
  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is null then raise exception 'idempotency_key_required'; end if;
  select id into v_movement_id from public.inventory_movements where idempotency_key=p_idempotency_key;
  if found then return v_movement_id; end if;
  insert into public.inventory_balances(product_id,location_id,quantity,allocated_quantity)
  values(p_product_id,p_location_id,0,0) on conflict(product_id,location_id) do nothing;
  select * into v_balance from public.inventory_balances
   where product_id=p_product_id and location_id=p_location_id for update;
  v_after:=v_balance.quantity+p_quantity_delta;
  if p_quantity_delta<0 and v_after<0 and not p_allow_negative then
    raise exception 'manufacturing_component_would_be_negative:%',p_product_id;
  end if;
  select display_name into v_user_name from public.app_users where id=p_actor_user_id and active;
  if v_user_name is null then raise exception 'manufacturing_actor_inactive'; end if;
  update public.inventory_balances set quantity=v_after,updated_at=now()
   where product_id=p_product_id and location_id=p_location_id;
  insert into public.inventory_movements(
    product_id,location_id,movement_type,quantity_delta,quantity_before,quantity_after,
    reference_type,reference_id,reason,idempotency_key,performed_by_user_id,performed_by_name,metadata
  ) values(
    p_product_id,p_location_id,p_movement_type,p_quantity_delta,v_balance.quantity,v_after,
    'manufacturing',p_work_order_id::text,p_reason,p_idempotency_key,p_actor_user_id,v_user_name,
    jsonb_build_object('source','manufacturing','outboundShopify',false,'workOrderId',p_work_order_id,
      'workOrderLineId',p_work_order_line_id,'completionEventId',p_completion_event_id)
  ) returning id into v_movement_id;
  return v_movement_id;
end $$;

create or replace function public.transition_mfg_work_order(
  p_actor_user_id bigint,p_work_order_id bigint,p_action text,p_idempotency_key text
) returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare v_wo public.mfg_work_orders%rowtype; v_from text; v_to text; v_existing jsonb;
begin
  if not public.mfg_actor_can(p_actor_user_id,'manufacturing_start_pause') then raise exception 'manufacturing_permission_denied:manufacturing_start_pause'; end if;
  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is null then raise exception 'idempotency_key_required'; end if;
  select * into v_wo from public.mfg_work_orders where id=p_work_order_id for update;
  if not found then raise exception 'work_order_not_found'; end if;
  if not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=v_wo.production_location_id and can_manage)
     or not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=v_wo.destination_location_id and can_manage)
  then raise exception 'manufacturing_location_permission_denied'; end if;
  select details into v_existing from public.mfg_audit_events where work_order_id=v_wo.id and idempotency_key=p_idempotency_key||':audit';
  if found then return v_existing; end if;
  v_from:=v_wo.status;
  if p_action='start' and v_from='Released' then v_to:='In Production';
  elsif p_action='pause' and v_from in ('In Production','Partially Completed') then v_to:='Paused';
  elsif p_action='resume' and v_from='Paused' then
    v_to:=case when exists(select 1 from public.mfg_completion_events where work_order_id=v_wo.id) then 'Partially Completed' else 'In Production' end;
  else raise exception 'invalid_work_order_transition:%:%',v_from,p_action;
  end if;
  update public.mfg_work_orders set status=v_to,started_at=coalesce(started_at,case when p_action='start' then now() end),
    started_by=coalesce(started_by,case when p_action='start' then p_actor_user_id end),updated_at=now() where id=v_wo.id;
  insert into public.mfg_status_history(work_order_id,from_status,to_status,changed_by,idempotency_key)
  values(v_wo.id,v_from,v_to,p_actor_user_id,p_idempotency_key||':status');
  v_existing:=jsonb_build_object('workOrderId',v_wo.id,'action',p_action,'fromStatus',v_from,'status',v_to,'alreadyApplied',false);
  insert into public.mfg_audit_events(work_order_id,event_type,actor_user_id,idempotency_key,details)
  values(v_wo.id,'lifecycle_'||p_action,p_actor_user_id,p_idempotency_key||':audit',v_existing);
  return v_existing;
end $$;

create or replace function public.assign_mfg_machine(
  p_actor_user_id bigint,p_work_order_id bigint,p_machine_code text,p_idempotency_key text
) returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare v_wo public.mfg_work_orders%rowtype; v_machine text:=upper(btrim(coalesce(p_machine_code,''))); v_result jsonb;
begin
  if not public.mfg_actor_can(p_actor_user_id,'manufacturing_assign_machine') then raise exception 'manufacturing_permission_denied:manufacturing_assign_machine'; end if;
  if v_machine not in ('NIGHTHAWK','TERMINATOR') then raise exception 'invalid_machine'; end if;
  select * into v_wo from public.mfg_work_orders where id=p_work_order_id for update;
  if not found then raise exception 'work_order_not_found'; end if;
  if not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=v_wo.production_location_id and can_manage)
     or not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=v_wo.destination_location_id and can_manage)
  then raise exception 'manufacturing_location_permission_denied'; end if;
  select details into v_result from public.mfg_audit_events where work_order_id=v_wo.id and idempotency_key=p_idempotency_key||':audit';
  if found then return v_result; end if;
  if v_wo.status not in ('Draft','Released','Paused') then raise exception 'machine_assignment_not_allowed:%',v_wo.status; end if;
  update public.mfg_work_orders set machine_code=v_machine,updated_at=now() where id=v_wo.id;
  v_result:=jsonb_build_object('workOrderId',v_wo.id,'machine',v_machine,'previousMachine',v_wo.machine_code,'alreadyApplied',false);
  insert into public.mfg_audit_events(work_order_id,event_type,actor_user_id,idempotency_key,details)
  values(v_wo.id,'machine_assigned',p_actor_user_id,p_idempotency_key||':audit',v_result);
  return v_result;
end $$;

create or replace function public.record_mfg_progress(
  p_actor_user_id bigint,p_work_order_id bigint,p_work_order_line_id bigint,
  p_disposition text,p_source_bucket text,p_quantity numeric,p_components jsonb,
  p_reason text,p_idempotency_key text
) returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare v_wo public.mfg_work_orders%rowtype; v_line public.mfg_work_order_lines%rowtype;
  v_event_id bigint; v_component record; v_movement_id bigint; v_standard boolean:=false;
  v_allow_negative boolean:=false; v_result jsonb; v_available numeric; v_release numeric;
  v_good numeric:=0; v_rejected numeric:=0; v_rework numeric:=0; v_scrap numeric:=0;
begin
  if not public.mfg_actor_can(p_actor_user_id,'manufacturing_record_progress') then raise exception 'manufacturing_permission_denied:manufacturing_record_progress'; end if;
  if p_disposition in ('good','rejected_pending','rework','scrap') and not public.mfg_actor_can(p_actor_user_id,'manufacturing_partial_complete') then
    raise exception 'manufacturing_permission_denied:manufacturing_partial_complete';
  end if;
  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is null then raise exception 'idempotency_key_required'; end if;
  if p_quantity is null or p_quantity<=0 then raise exception 'progress_quantity_must_be_positive'; end if;
  if p_disposition not in ('good','rejected_pending','rework','scrap') then raise exception 'invalid_progress_disposition'; end if;
  if p_source_bucket not in ('unstarted','rejected_pending','rework') then raise exception 'invalid_progress_source_bucket'; end if;
  if p_disposition='rejected_pending' and p_source_bucket<>'unstarted' then raise exception 'rejected_pending_requires_unstarted_source'; end if;
  if p_disposition='rework' and p_source_bucket='rework' then raise exception 'rework_cannot_source_itself'; end if;
  if p_disposition='scrap' and nullif(btrim(coalesce(p_reason,'')),'') is null then raise exception 'scrap_reason_required'; end if;
  if p_disposition in ('scrap') and (jsonb_typeof(coalesce(p_components,'[]'::jsonb))<>'array') then raise exception 'explicit_component_array_required'; end if;
  if jsonb_array_length(coalesce(p_components,'[]'::jsonb))>0
     and not (p_disposition='scrap' or (p_disposition='good' and p_source_bucket='rework'))
  then raise exception 'explicit_components_only_for_scrap_or_rework_resolution'; end if;
  if (select count(*) from jsonb_to_recordset(coalesce(p_components,'[]'::jsonb)) x(component_product_id bigint,quantity numeric)) <>
     (select count(distinct component_product_id) from jsonb_to_recordset(coalesce(p_components,'[]'::jsonb)) x(component_product_id bigint,quantity numeric))
  then raise exception 'duplicate_explicit_component'; end if;

  select * into v_wo from public.mfg_work_orders where id=p_work_order_id for update;
  if not found then raise exception 'work_order_not_found'; end if;
  if v_wo.status not in ('In Production','Partially Completed') then raise exception 'production_status_not_active:%',v_wo.status; end if;
  if not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=v_wo.production_location_id)
     or not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=v_wo.destination_location_id)
  then raise exception 'manufacturing_location_permission_denied'; end if;
  select * into v_line from public.mfg_work_order_lines where id=p_work_order_line_id and work_order_id=v_wo.id for update;
  if not found then raise exception 'work_order_line_not_found'; end if;
  select id,result_payload into v_event_id,v_result from public.mfg_completion_events
    where work_order_id=v_wo.id and work_order_line_id=v_line.id and idempotency_key=p_idempotency_key;
  if found then return v_result; end if;
  if p_source_bucket='unstarted' and p_quantity>v_line.remaining_quantity then raise exception 'progress_would_overcomplete_line'; end if;
  if p_source_bucket='rejected_pending' and p_quantity>v_line.rejected_quantity then raise exception 'rejected_resolution_exceeds_pending'; end if;
  if p_source_bucket='rework' and p_quantity>v_line.rework_quantity then raise exception 'rework_resolution_exceeds_pending'; end if;

  -- An unstarted good/rejected/rework attempt consumes one frozen standard BOM exactly once.
  v_standard:=p_source_bucket='unstarted' and p_disposition in ('good','rejected_pending','rework');
  insert into public.mfg_completion_events(
    work_order_id,work_order_line_id,good_quantity,rejected_quantity,scrap_quantity,rework_quantity,
    notes,idempotency_key,recorded_by,event_type,source_bucket
  ) values(
    v_wo.id,v_line.id,case when p_disposition='good' then p_quantity else 0 end,
    case when p_disposition='rejected_pending' then p_quantity else 0 end,
    case when p_disposition='scrap' then p_quantity else 0 end,
    case when p_disposition='rework' then p_quantity else 0 end,
    nullif(btrim(coalesce(p_reason,'')),''),p_idempotency_key,p_actor_user_id,p_disposition,p_source_bucket
  ) returning id into v_event_id;

  if current_setting('mfg.test_failpoint',true)='after_component_calculation' then raise exception 'injected_failure:after_component_calculation'; end if;

  if v_standard then
    for v_component in
      select sc.component_product_id,p_quantity*sc.quantity_per_yield/s.yield_quantity quantity
      from public.mfg_work_order_bom_snapshots s
      join public.mfg_work_order_snapshot_components sc on sc.snapshot_id=s.id
      where s.work_order_line_id=v_line.id order by sc.component_product_id
    loop
      select exists(select 1 from public.mfg_shortage_overrides
        where work_order_id=v_wo.id and component_product_id=v_component.component_product_id)
        into v_allow_negative;
      v_movement_id:=public.mfg_apply_inventory_movement(p_actor_user_id,v_wo.id,v_line.id,v_event_id,
        v_component.component_product_id,v_wo.production_location_id,-v_component.quantity,'production_consume',
        'Frozen BOM component consumption',p_idempotency_key||':standard:'||v_component.component_product_id,v_allow_negative);
      insert into public.mfg_component_consumption_events(
        completion_event_id,component_product_id,quantity,cost_per_unit_snapshot,cost_source,idempotency_key,consumption_type,reason
      ) values(v_event_id,v_component.component_product_id,v_component.quantity,null,null,
        p_idempotency_key||':consumption:'||v_component.component_product_id,'standard_attempt','Frozen BOM standard attempt');
      update public.mfg_component_allocations set consumed_quantity=consumed_quantity+v_component.quantity,
        status=case when consumed_quantity+v_component.quantity+released_quantity=allocated_quantity then 'consumed' else 'partially_consumed' end
      where work_order_id=v_wo.id and component_product_id=v_component.component_product_id
        and consumed_quantity+released_quantity+v_component.quantity<=allocated_quantity;
      if not found then raise exception 'component_allocation_reconciliation_failed:%',v_component.component_product_id; end if;
    end loop;
  end if;

  -- Scrap and rework-resolution extras consume only quantities explicitly supplied.
  if jsonb_array_length(coalesce(p_components,'[]'::jsonb))>0 then
    for v_component in
      select x.component_product_id,x.quantity
      from jsonb_to_recordset(p_components) x(component_product_id bigint,quantity numeric)
      order by x.component_product_id
    loop
      if v_component.component_product_id is null or v_component.quantity is null or v_component.quantity<=0 then raise exception 'invalid_explicit_component'; end if;
      if not exists(
        select 1 from public.mfg_work_order_bom_snapshots s join public.mfg_work_order_snapshot_components sc on sc.snapshot_id=s.id
        where s.work_order_line_id=v_line.id and sc.component_product_id=v_component.component_product_id
      ) and not public.mfg_actor_can(p_actor_user_id,'manufacturing_admin_correction') then
        raise exception 'explicit_component_not_in_frozen_bom:%',v_component.component_product_id;
      end if;
      select exists(select 1 from public.mfg_shortage_overrides
        where work_order_id=v_wo.id and component_product_id=v_component.component_product_id)
        into v_allow_negative;
      v_movement_id:=public.mfg_apply_inventory_movement(p_actor_user_id,v_wo.id,v_line.id,v_event_id,
        v_component.component_product_id,v_wo.production_location_id,-v_component.quantity,'production_consume',
        case when p_disposition='scrap' then 'Explicit component scrap' else 'Explicit rework component' end,
        p_idempotency_key||':explicit:'||v_component.component_product_id,v_allow_negative);
      insert into public.mfg_component_consumption_events(
        completion_event_id,component_product_id,quantity,cost_per_unit_snapshot,cost_source,idempotency_key,consumption_type,reason
      ) values(v_event_id,v_component.component_product_id,v_component.quantity,null,null,
        p_idempotency_key||':explicit-consumption:'||v_component.component_product_id,
        case when p_disposition='scrap' then 'explicit_scrap' else 'rework_additional' end,btrim(coalesce(p_reason,'Explicit component use')));
    end loop;
  end if;

  if current_setting('mfg.test_failpoint',true)='after_component_consumption' then raise exception 'injected_failure:after_component_consumption'; end if;

  -- A direct scrap never assumes a full-BOM consumption; release its unused standard reservation.
  if p_source_bucket='unstarted' and p_disposition='scrap' then
    for v_component in
      select sc.component_product_id,p_quantity*sc.quantity_per_yield/s.yield_quantity quantity
      from public.mfg_work_order_bom_snapshots s join public.mfg_work_order_snapshot_components sc on sc.snapshot_id=s.id
      where s.work_order_line_id=v_line.id order by sc.component_product_id
    loop
      update public.mfg_component_allocations set released_quantity=released_quantity+v_component.quantity,
        status=case when consumed_quantity+released_quantity+v_component.quantity=allocated_quantity then 'released' else 'partially_consumed' end,
        released_at=case when consumed_quantity+released_quantity+v_component.quantity=allocated_quantity then now() else released_at end
      where work_order_id=v_wo.id and component_product_id=v_component.component_product_id
        and consumed_quantity+released_quantity+v_component.quantity<=allocated_quantity;
      if not found then raise exception 'component_release_reconciliation_failed:%',v_component.component_product_id; end if;
    end loop;
  end if;

  if p_source_bucket='rejected_pending' then v_rejected:=-p_quantity;
  elsif p_source_bucket='rework' then v_rework:=-p_quantity;
  end if;
  if p_disposition='good' then v_good:=p_quantity;
  elsif p_disposition='rejected_pending' then v_rejected:=v_rejected+p_quantity;
  elsif p_disposition='rework' then v_rework:=v_rework+p_quantity;
  elsif p_disposition='scrap' then v_scrap:=p_quantity;
  end if;
  update public.mfg_work_order_lines set good_quantity=good_quantity+v_good,
    rejected_quantity=rejected_quantity+v_rejected,rework_quantity=rework_quantity+v_rework,
    scrap_quantity=scrap_quantity+v_scrap,updated_at=now() where id=v_line.id;

  if p_disposition='good' then
    v_movement_id:=public.mfg_apply_inventory_movement(p_actor_user_id,v_wo.id,v_line.id,v_event_id,
      v_line.finished_product_id,v_wo.production_location_id,p_quantity,'production_complete',
      'Good production completed at 730',p_idempotency_key||':finished',false);
    insert into public.mfg_finished_inventory_events(completion_event_id,product_id,location_id,good_quantity,inventory_movement_id,idempotency_key)
    values(v_event_id,v_line.finished_product_id,v_wo.production_location_id,p_quantity,v_movement_id,p_idempotency_key||':finished-link');
  end if;

  if current_setting('mfg.test_failpoint',true)='before_transfer_update' then raise exception 'injected_failure:before_transfer_update'; end if;
  if p_disposition='good' then
    update public.mfg_planned_transfer_lines ptl set transferable_quantity=transferable_quantity+p_quantity,updated_at=now()
    from public.mfg_planned_transfers pt where pt.id=ptl.planned_transfer_id and pt.work_order_id=v_wo.id
      and ptl.product_id=v_line.finished_product_id and pt.status='planned'
      and ptl.transferable_quantity+p_quantity<=ptl.planned_quantity;
    if not found then raise exception 'planned_transfer_reconciliation_failed'; end if;
  end if;
  update public.mfg_work_orders set status='Partially Completed',updated_at=now() where id=v_wo.id;
  if v_wo.status<>'Partially Completed' then
    insert into public.mfg_status_history(work_order_id,from_status,to_status,changed_by,idempotency_key)
    values(v_wo.id,v_wo.status,'Partially Completed',p_actor_user_id,p_idempotency_key||':status');
  end if;
  insert into public.mfg_cost_snapshots(completion_event_id,cost_status,unavailable_reason)
  values(v_event_id,'unavailable','Cost unavailable — component cost source not configured');
  v_result:=jsonb_build_object('workOrderId',v_wo.id,'workOrderLineId',v_line.id,'completionEventId',v_event_id,
    'disposition',p_disposition,'sourceBucket',p_source_bucket,'quantity',p_quantity,'alreadyApplied',false,
    'costAvailable',false,'costMessage','Cost unavailable — component cost source not configured');
  update public.mfg_completion_events set result_payload=v_result where id=v_event_id;
  insert into public.mfg_audit_events(work_order_id,event_type,actor_user_id,idempotency_key,details)
  values(v_wo.id,'progress_'||p_disposition,p_actor_user_id,p_idempotency_key||':audit',v_result||jsonb_build_object('shopifyCall',false));
  return v_result;
end $$;

create or replace function public.complete_mfg_work_order(
  p_actor_user_id bigint,p_work_order_id bigint,p_idempotency_key text
) returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare v_wo public.mfg_work_orders%rowtype; v_plan public.mfg_planned_transfers%rowtype;
  v_transfer_id bigint; v_transfer_number text; v_result jsonb;
begin
  if not public.mfg_actor_can(p_actor_user_id,'manufacturing_complete') then raise exception 'manufacturing_permission_denied:manufacturing_complete'; end if;
  select * into v_wo from public.mfg_work_orders where id=p_work_order_id for update;
  if not found then raise exception 'work_order_not_found'; end if;
  if not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=v_wo.production_location_id and can_manage)
     or not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=v_wo.destination_location_id and can_manage)
  then raise exception 'manufacturing_location_permission_denied'; end if;
  select details into v_result from public.mfg_audit_events where work_order_id=v_wo.id and idempotency_key=p_idempotency_key||':audit';
  if found then return v_result; end if;
  if v_wo.status not in ('In Production','Partially Completed') then raise exception 'work_order_not_ready_to_complete:%',v_wo.status; end if;
  if exists(select 1 from public.mfg_work_order_lines where work_order_id=v_wo.id and (remaining_quantity<>0 or rejected_quantity<>0 or rework_quantity<>0))
  then raise exception 'all_units_and_dispositions_must_be_resolved'; end if;
  if exists(
    select 1 from public.mfg_work_order_lines l left join public.mfg_planned_transfers pt on pt.work_order_id=l.work_order_id
    left join public.mfg_planned_transfer_lines ptl on ptl.planned_transfer_id=pt.id and ptl.product_id=l.finished_product_id
    where l.work_order_id=v_wo.id and coalesce(ptl.transferable_quantity,-1)<>l.good_quantity
  ) then raise exception 'planned_transfer_does_not_equal_good_production'; end if;
  select * into v_plan from public.mfg_planned_transfers where work_order_id=v_wo.id for update;
  if not found or v_plan.status<>'planned' then raise exception 'planned_transfer_not_promotable'; end if;
  v_transfer_number:='MT-'||to_char(clock_timestamp(),'YYYYMMDD-HH24MISSMS');
  insert into public.transfers(transfer_number,from_location_id,to_location_id,status,notes,created_by_user_id,created_by_name)
  select v_transfer_number,v_wo.production_location_id,v_wo.destination_location_id,'draft',
    'Manufacturing output for '||v_wo.work_order_number,p_actor_user_id,u.display_name
  from public.app_users u where u.id=p_actor_user_id and u.active returning id into v_transfer_id;
  if v_transfer_id is null then raise exception 'manufacturing_actor_inactive'; end if;
  insert into public.transfer_lines(transfer_id,product_id,requested_quantity,allocated_quantity)
  select v_transfer_id,l.finished_product_id,l.good_quantity,0 from public.mfg_work_order_lines l
  where l.work_order_id=v_wo.id and l.good_quantity>0;
  if not exists(select 1 from public.transfer_lines where transfer_id=v_transfer_id) then raise exception 'completed_work_order_has_no_good_output'; end if;
  update public.mfg_planned_transfers set status='promoted',physical_transfer_id=v_transfer_id,updated_at=now() where id=v_plan.id;
  update public.mfg_work_orders set status='Completed',completed_at=now(),updated_at=now() where id=v_wo.id;
  insert into public.mfg_status_history(work_order_id,from_status,to_status,changed_by,idempotency_key)
  values(v_wo.id,v_wo.status,'Completed',p_actor_user_id,p_idempotency_key||':status');
  v_result:=jsonb_build_object('workOrderId',v_wo.id,'status','Completed','transferId',v_transfer_id,
    'transferNumber',v_transfer_number,'transferStatus','draft','alreadyCompleted',false,'shopifyCall',false);
  insert into public.mfg_audit_events(work_order_id,event_type,actor_user_id,idempotency_key,details)
  values(v_wo.id,'completed_and_transfer_promoted',p_actor_user_id,p_idempotency_key||':audit',v_result);
  return v_result;
end $$;

create or replace function public.close_mfg_work_order(
  p_actor_user_id bigint,p_work_order_id bigint,p_idempotency_key text
) returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare v_wo public.mfg_work_orders%rowtype; v_result jsonb;
begin
  if not public.mfg_actor_can(p_actor_user_id,'manufacturing_close') then raise exception 'manufacturing_permission_denied:manufacturing_close'; end if;
  select * into v_wo from public.mfg_work_orders where id=p_work_order_id for update;
  if not found then raise exception 'work_order_not_found'; end if;
  if not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=v_wo.production_location_id and can_manage)
     or not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=v_wo.destination_location_id and can_manage)
  then raise exception 'manufacturing_location_permission_denied'; end if;
  select details into v_result from public.mfg_audit_events where work_order_id=v_wo.id and idempotency_key=p_idempotency_key||':audit';
  if found then return v_result; end if;
  if v_wo.status<>'Completed' then raise exception 'only_completed_work_order_can_close'; end if;
  if exists(select 1 from public.mfg_work_order_lines where work_order_id=v_wo.id and (remaining_quantity<>0 or rejected_quantity<>0 or rework_quantity<>0))
    or not exists(select 1 from public.mfg_planned_transfers where work_order_id=v_wo.id and status='promoted' and physical_transfer_id is not null)
  then raise exception 'work_order_reconciliation_incomplete'; end if;
  update public.mfg_work_orders set status='Closed',closed_at=now(),closed_by=p_actor_user_id,updated_at=now() where id=v_wo.id;
  insert into public.mfg_status_history(work_order_id,from_status,to_status,changed_by,idempotency_key)
  values(v_wo.id,'Completed','Closed',p_actor_user_id,p_idempotency_key||':status');
  v_result:=jsonb_build_object('workOrderId',v_wo.id,'status','Closed','inventoryEffect',false,'alreadyClosed',false);
  insert into public.mfg_audit_events(work_order_id,event_type,actor_user_id,idempotency_key,details)
  values(v_wo.id,'closed',p_actor_user_id,p_idempotency_key||':audit',v_result||jsonb_build_object('shopifyCall',false));
  return v_result;
end $$;

-- Phase 2 permission names; cancellation remains inventory-neutral.
create or replace function public.cancel_mfg_work_order(
  p_actor_user_id bigint,p_work_order_id bigint,p_reason text,p_idempotency_key text
) returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare v_wo public.mfg_work_orders%rowtype; v_result jsonb;
begin
  if not public.mfg_actor_can(p_actor_user_id,'manufacturing_cancel') then raise exception 'manufacturing_permission_denied:manufacturing_cancel'; end if;
  if nullif(btrim(coalesce(p_reason,'')),'') is null then raise exception 'cancellation_reason_required'; end if;
  select * into v_wo from public.mfg_work_orders where id=p_work_order_id for update;
  if not found then raise exception 'work_order_not_found'; end if;
  if not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=v_wo.production_location_id and can_manage)
     or not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=v_wo.destination_location_id and can_manage)
  then raise exception 'manufacturing_location_permission_denied'; end if;
  select details into v_result from public.mfg_audit_events where work_order_id=v_wo.id and idempotency_key=p_idempotency_key||':audit';
  if found then return v_result; end if;
  if v_wo.status in ('In Production','Paused','Partially Completed') then raise exception 'started_work_requires_controlled_correction_or_early_close'; end if;
  if v_wo.status in ('Completed','Closed') then raise exception 'completed_production_cannot_be_cancelled'; end if;
  if v_wo.status not in ('Draft','Released') then raise exception 'work_order_cannot_be_cancelled'; end if;
  if v_wo.status='Released' then
    update public.mfg_component_allocations set released_quantity=allocated_quantity-consumed_quantity,
      status='released',released_at=now() where work_order_id=v_wo.id and status in ('active','partially_consumed');
    update public.mfg_planned_transfers set status='cancelled',updated_at=now() where work_order_id=v_wo.id and status='planned';
  end if;
  update public.mfg_work_orders set status='Cancelled',cancelled_by=p_actor_user_id,cancelled_at=now(),
    cancellation_reason=btrim(p_reason),cancellation_idempotency_key=p_idempotency_key,updated_at=now() where id=v_wo.id;
  insert into public.mfg_status_history(work_order_id,from_status,to_status,reason,changed_by,idempotency_key)
  values(v_wo.id,v_wo.status,'Cancelled',btrim(p_reason),p_actor_user_id,p_idempotency_key||':status');
  v_result:=jsonb_build_object('workOrderId',v_wo.id,'previousStatus',v_wo.status,'status','Cancelled',
    'inventoryEffect',false,'alreadyCancelled',false);
  insert into public.mfg_audit_events(work_order_id,event_type,actor_user_id,idempotency_key,details)
  values(v_wo.id,'cancelled',p_actor_user_id,p_idempotency_key||':audit',v_result||jsonb_build_object('reason',btrim(p_reason),'shopifyCall',false));
  return v_result;
end $$;

-- Adopt granular permissions in the Phase 1 entry points.
create or replace function public.mfg_actor_can(p_actor_user_id bigint,p_permission text)
returns boolean language sql stable security invoker set search_path='pg_catalog','public' as $$
  with requested(permission) as (select case p_permission
    when 'draft_create' then 'manufacturing_create_draft'
    when 'release' then 'manufacturing_release'
    when 'machine_assign' then 'manufacturing_assign_machine'
    when 'start_pause' then 'manufacturing_start_pause'
    when 'partial_complete' then 'manufacturing_partial_complete'
    when 'scrap_rework' then 'manufacturing_record_progress'
    when 'shortage_override' then 'manufacturing_shortage_override'
    when 'cancel' then 'manufacturing_cancel'
    when 'close' then 'manufacturing_close'
    when 'bom_admin' then 'manufacturing_bom_admin'
    when 'cost_admin' then 'manufacturing_cost_admin'
    else p_permission end)
  select coalesce(
    (select o.allowed from requested r join public.mfg_user_permission_overrides o on o.permission=r.permission
      join public.app_users u on u.id=o.user_id and u.active where o.user_id=p_actor_user_id),
    (select rp.allowed from requested r join public.app_users u on u.id=p_actor_user_id and u.active
      join public.mfg_role_permissions rp on rp.role=u.role and rp.permission=r.permission),false
  )
$$;

revoke all on function public.mfg_apply_inventory_movement(bigint,bigint,bigint,bigint,bigint,bigint,numeric,text,text,text,boolean) from public,anon,authenticated;
revoke all on function public.transition_mfg_work_order(bigint,bigint,text,text) from public,anon,authenticated;
revoke all on function public.assign_mfg_machine(bigint,bigint,text,text) from public,anon,authenticated;
revoke all on function public.record_mfg_progress(bigint,bigint,bigint,text,text,numeric,jsonb,text,text) from public,anon,authenticated;
revoke all on function public.complete_mfg_work_order(bigint,bigint,text) from public,anon,authenticated;
revoke all on function public.close_mfg_work_order(bigint,bigint,text) from public,anon,authenticated;
revoke all on function public.cancel_mfg_work_order(bigint,bigint,text,text) from public,anon,authenticated;
grant execute on function public.mfg_apply_inventory_movement(bigint,bigint,bigint,bigint,bigint,bigint,numeric,text,text,text,boolean) to service_role;
grant execute on function public.transition_mfg_work_order(bigint,bigint,text,text) to service_role;
grant execute on function public.assign_mfg_machine(bigint,bigint,text,text) to service_role;
grant execute on function public.record_mfg_progress(bigint,bigint,bigint,text,text,numeric,jsonb,text,text) to service_role;
grant execute on function public.complete_mfg_work_order(bigint,bigint,text) to service_role;
grant execute on function public.close_mfg_work_order(bigint,bigint,text) to service_role;
grant execute on function public.cancel_mfg_work_order(bigint,bigint,text,text) to service_role;

commit;
