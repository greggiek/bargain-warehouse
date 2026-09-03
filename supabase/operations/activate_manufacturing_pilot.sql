-- Operator-run activation transaction for BM-MFG-PILOT-001.
-- DO NOT run until the bound work order and activation are explicitly approved.
begin;
set transaction isolation level serializable;

select pg_advisory_xact_lock(hashtext('BM-MFG-PILOT-001'));
select set_config('bm.approved_work_order_id', :'approved_work_order_id', true);

do $activation$
declare
  g public.manufacturing_pilot_gate%rowtype;
  w public.mfg_work_orders%rowtype;
  v_work_order_id bigint := current_setting('bm.approved_work_order_id')::bigint;
  v_expected_flag_count integer;
  v_updated_flag_count integer;
  v_enabled_flag_count integer;
begin
  select *
    into g
    from public.manufacturing_pilot_gate
   where pilot_identifier = 'BM-MFG-PILOT-001'
   for update;

  if not found
     or g.enabled
     or g.approved_work_order_id <> v_work_order_id
     or g.approved_finished_product_id <> 3523
     or g.approved_bom_id <> 194
     or g.origin_location_id <> 6
     or g.destination_location_id <> 2
     or g.machine_code <> 'NIGHTHAWK'
     or g.approved_user_ids <> array[3,18]::bigint[]
  then
    raise exception 'pilot_activation_scope_mismatch';
  end if;

  select *
    into w
    from public.mfg_work_orders
   where id = v_work_order_id
   for update;

  if not found
     or lower(w.status) <> 'draft'
     or w.pilot_identifier <> 'BM-MFG-PILOT-001'
     or w.pilot_work_order_id <> w.id
     or w.production_location_id <> 6
     or w.destination_location_id <> 2
     or w.machine_code <> 'NIGHTHAWK'
  then
    raise exception 'pilot_work_order_scope_mismatch';
  end if;

  if (select count(*) from public.mfg_work_order_lines where work_order_id = w.id) <> 1
     or not exists (
       select 1
         from public.mfg_work_order_lines
        where work_order_id = w.id
          and finished_product_id = 3523
          and planned_quantity = 1
     )
  then
    raise exception 'pilot_line_scope_mismatch';
  end if;

  if not exists (
       select 1
         from public.mfg_bom_versions
        where finished_product_id = 3523
          and source_bom_id = 194
          and status = 'active'
          and component_hash = '40f80960b3866b165f90922ba9e21c14'
     )
  then
    raise exception 'pilot_bom_mismatch';
  end if;

  if exists (
       select 1 from public.mfg_component_allocations where work_order_id = w.id
       union all
       select 1 from public.mfg_completion_events where work_order_id = w.id
       union all
       select 1 from public.mfg_shopify_inventory_adjustments where work_order_id = w.id
       union all
       select 1 from public.mfg_transfer_handoffs where work_order_id = w.id
     )
  then
    raise exception 'pilot_draft_has_effects';
  end if;

  if exists (
       select 1
         from public.mfg_work_orders
        where id <> w.id
          and pilot_identifier is not null
          and lower(status) not in ('closed','cancelled')
     )
  then
    raise exception 'conflicting_active_pilot';
  end if;

  if exists (
       select 1
         from public.mfg_feature_flags
        where flag_key in (
          'manufacturing_release_enabled',
          'manufacturing_completion_enabled',
          'manufacturing_inventory_mutations_enabled',
          'manufacturing_shopify_outbound_enabled',
          'manufacturing_transfer_handoff_enabled'
        )
          and enabled
     )
  then
    raise exception 'general_manufacturing_flag_enabled';
  end if;

  perform public.mfg_validate_pilot_component_availability(w.id);

  select count(*)
    into v_expected_flag_count
    from public.mfg_feature_flags
   where flag_key in (
     'manufacturing_pilot_release_enabled',
     'manufacturing_pilot_completion_enabled',
     'manufacturing_pilot_inventory_enabled',
     'manufacturing_pilot_outbound_enabled',
     'manufacturing_pilot_transfer_enabled'
   );

  if v_expected_flag_count <> 5 then
    raise exception 'pilot_capability_flags_missing: expected 5 rows, found %', v_expected_flag_count;
  end if;

  update public.mfg_feature_flags
     set enabled = true,
         updated_at = now()
   where flag_key in (
     'manufacturing_pilot_release_enabled',
     'manufacturing_pilot_completion_enabled',
     'manufacturing_pilot_inventory_enabled',
     'manufacturing_pilot_outbound_enabled',
     'manufacturing_pilot_transfer_enabled'
   );

  get diagnostics v_updated_flag_count = row_count;
  if v_updated_flag_count <> 5 then
    raise exception 'pilot_capability_flag_update_incomplete: expected 5 rows, updated %', v_updated_flag_count;
  end if;

  select count(*)
    into v_enabled_flag_count
    from public.mfg_feature_flags
   where flag_key in (
     'manufacturing_pilot_release_enabled',
     'manufacturing_pilot_completion_enabled',
     'manufacturing_pilot_inventory_enabled',
     'manufacturing_pilot_outbound_enabled',
     'manufacturing_pilot_transfer_enabled'
   )
     and enabled;

  if v_enabled_flag_count <> 5 then
    raise exception 'pilot_capability_flag_enable_incomplete: expected 5 enabled rows, found %', v_enabled_flag_count;
  end if;

  update public.manufacturing_pilot_gate
     set enabled = true
   where pilot_identifier = 'BM-MFG-PILOT-001'
     and approved_work_order_id = v_work_order_id
     and enabled = false;

  if not found then
    raise exception 'pilot_gate_activation_failed';
  end if;

  insert into public.mfg_audit_events(
    work_order_id,event_type,actor_user_id,idempotency_key,details,
    pilot_identifier,pilot_work_order_id
  ) values (
    w.id,'pilot_activated',3,'BM-MFG-PILOT-001:activate:' || w.id,
    jsonb_build_object(
      'quantity',1,'originLocationId',6,'destinationLocationId',2,
      'machine','NIGHTHAWK','sourceStore','store_2',
      'destinationStore','store_1','routeType','cross_store'
    ),
    'BM-MFG-PILOT-001',w.id
  );
end
$activation$;

commit;
