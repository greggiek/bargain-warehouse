-- Keep record-type-specific fields inside their table branch. The previous
-- elsif expression attempted to resolve inventory_movements.reference_type
-- while stamping a Shopify transfer link.
begin;

create or replace function public.guard_mfg_pilot_ownership()
returns trigger language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare v_pilot text;v_wo bigint;
begin
 if tg_table_name='mfg_work_orders' then
  if tg_op='UPDATE' and(old.pilot_identifier is distinct from new.pilot_identifier or old.pilot_work_order_id is distinct from new.pilot_work_order_id)
   and old.pilot_identifier is not null then raise exception 'pilot_ownership_immutable';end if;
  return new;
 end if;
 if tg_op='UPDATE' and(old.pilot_identifier is distinct from new.pilot_identifier or old.pilot_work_order_id is distinct from new.pilot_work_order_id)
 then raise exception 'pilot_ownership_immutable';end if;
 if tg_op='UPDATE' then return new;end if;
 if tg_table_name in('mfg_component_allocations','mfg_completion_events','mfg_transfer_handoffs','mfg_audit_events','mfg_shopify_inventory_adjustments') then
  v_wo:=new.work_order_id;
 elsif tg_table_name='mfg_component_consumption_events' then
  select e.work_order_id into v_wo from public.mfg_completion_events e where e.id=new.completion_event_id;
 elsif tg_table_name='mfg_finished_inventory_events' then
  select e.work_order_id into v_wo from public.mfg_completion_events e where e.id=new.completion_event_id;
 elsif tg_table_name='inventory_movements' then
  if new.reference_type='manufacturing' then v_wo:=new.reference_id::bigint;end if;
 elsif tg_table_name='shopify_transfer_links' then
  if new.manufacturing_handoff_id is not null then
   select h.work_order_id into v_wo from public.mfg_transfer_handoffs h where h.id=new.manufacturing_handoff_id;
  end if;
 end if;
 if v_wo is not null then
  select w.pilot_identifier,w.pilot_work_order_id into v_pilot,v_wo from public.mfg_work_orders w where w.id=v_wo;
 end if;
 new.pilot_identifier:=v_pilot;new.pilot_work_order_id:=v_wo;return new;
end $$;

update public.manufacturing_pilot_gate set enabled=false where pilot_identifier='BM-MFG-PILOT-001';
update public.mfg_feature_flags set enabled=false,updated_at=now()
where flag_key in('manufacturing_release_enabled','manufacturing_completion_enabled','manufacturing_transfer_handoff_enabled',
 'manufacturing_shopify_outbound_enabled','manufacturing_inventory_mutations_enabled','manufacturing_pilot_release_enabled',
 'manufacturing_pilot_completion_enabled','manufacturing_pilot_inventory_enabled','manufacturing_pilot_outbound_enabled','manufacturing_pilot_transfer_enabled');

commit;
