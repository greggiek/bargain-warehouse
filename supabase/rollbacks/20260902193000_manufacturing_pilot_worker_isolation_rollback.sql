begin;
-- Safe only before a pilot is bound or has any owned operational records.
do $$ begin
 if exists(select 1 from public.manufacturing_pilot_gate where approved_work_order_id is not null)
  or exists(select 1 from public.mfg_work_orders where pilot_identifier is not null)
 then raise exception 'pilot_worker_isolation_rollback_blocked_owned_records_exist';end if;
end $$;
drop trigger if exists stamp_mfg_audit_pilot on public.mfg_audit_events;
drop trigger if exists stamp_shopify_link_pilot on public.shopify_transfer_links;
drop trigger if exists stamp_mfg_handoff_pilot on public.mfg_transfer_handoffs;
drop trigger if exists stamp_mfg_adjustment_pilot on public.mfg_shopify_inventory_adjustments;
drop trigger if exists stamp_inventory_movement_pilot on public.inventory_movements;
drop trigger if exists stamp_mfg_finished_pilot on public.mfg_finished_inventory_events;
drop trigger if exists stamp_mfg_consumption_pilot on public.mfg_component_consumption_events;
drop trigger if exists stamp_mfg_completion_pilot on public.mfg_completion_events;
drop trigger if exists stamp_mfg_alloc_pilot on public.mfg_component_allocations;
drop trigger if exists guard_mfg_work_order_pilot on public.mfg_work_orders;
drop trigger if exists guard_manufacturing_pilot_binding on public.manufacturing_pilot_gate;
drop function if exists public.guard_manufacturing_pilot_binding();
drop function if exists public.guard_mfg_pilot_ownership();
drop function if exists public.bind_manufacturing_pilot_draft(bigint,bigint);
drop function if exists public.run_manufacturing_pilot_action(bigint,bigint,text,text);
drop function if exists public.mfg_validate_pilot_work_order(bigint,bigint);
drop function if exists public.mfg_worker_record_eligible(bigint,text,bigint,text,text);
drop function if exists public.assert_mfg_worker_claim_eligible(text,bigint,uuid);
drop function if exists public.mfg_pilot_flag_enabled(text);
alter table public.mfg_audit_events drop column pilot_work_order_id,drop column pilot_identifier;
alter table public.shopify_transfer_links drop column pilot_work_order_id,drop column pilot_identifier;
alter table public.mfg_transfer_handoffs drop column pilot_work_order_id,drop column pilot_identifier;
alter table public.mfg_shopify_inventory_adjustments drop column pilot_work_order_id,drop column pilot_identifier;
alter table public.inventory_movements drop column pilot_work_order_id,drop column pilot_identifier;
alter table public.mfg_finished_inventory_events drop column pilot_work_order_id,drop column pilot_identifier;
alter table public.mfg_component_consumption_events drop column pilot_work_order_id,drop column pilot_identifier;
alter table public.mfg_completion_events drop column pilot_work_order_id,drop column pilot_identifier;
alter table public.mfg_component_allocations drop column pilot_work_order_id,drop column pilot_identifier;
alter table public.mfg_work_orders drop column pilot_work_order_id,drop column pilot_identifier;
alter table public.manufacturing_pilot_gate drop column approved_work_order_id;
delete from public.mfg_feature_flags where flag_key like 'manufacturing_pilot_%_enabled';
commit;
