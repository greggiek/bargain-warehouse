-- Roll back only the additive V2 foundation. The security revocation on the legacy
-- release RPC is intentionally retained; restoring anonymous release is unsafe.

drop function if exists public.mfg_cost_availability(bigint);
drop function if exists public.cancel_mfg_work_order(bigint,bigint,text,text);
drop function if exists public.release_mfg_work_order(bigint,bigint,text,text);
drop function if exists public.create_mfg_work_order_draft(bigint,bigint,text,jsonb,text,date,text,text);
drop function if exists public.mfg_actor_can(bigint,text);

drop table if exists public.mfg_cost_snapshot_components;
drop table if exists public.mfg_cost_snapshots;
drop table if exists public.mfg_standard_labor_rules;
drop table if exists public.mfg_finished_inventory_events;
drop table if exists public.mfg_component_consumption_events;
drop table if exists public.mfg_completion_events;
drop table if exists public.mfg_shortage_overrides;
drop table if exists public.mfg_work_order_notes;
drop table if exists public.mfg_status_history;
drop table if exists public.mfg_audit_events;
drop table if exists public.mfg_planned_transfer_lines;
drop table if exists public.mfg_planned_transfers;
drop table if exists public.mfg_component_allocations;
drop table if exists public.mfg_work_order_snapshot_components;
drop table if exists public.mfg_work_order_bom_snapshots;
drop table if exists public.mfg_work_order_lines;
drop table if exists public.mfg_work_orders;
drop sequence if exists public.mfg_work_order_number_seq;
drop table if exists public.mfg_bom_version_components;
drop table if exists public.mfg_bom_versions;
drop table if exists public.mfg_user_permission_overrides;
drop table if exists public.mfg_role_permissions;
drop table if exists public.mfg_feature_flags;

revoke all on function public.start_v2_stock_production_job(bigint,jsonb,text,text,text,bigint,text)
  from public,anon,authenticated;
grant execute on function public.start_v2_stock_production_job(bigint,jsonb,text,text,text,bigint,text)
  to service_role;
