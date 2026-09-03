begin;
do $$ begin
 if exists(select 1 from public.shopify_transfer_links where pilot_identifier is not null)
 then raise exception 'manufacturing_transfer_router_rollback_blocked_pilot_transfer_exists';end if;
end $$;
drop trigger if exists stamp_intercompany_attempt_pilot on public.intercompany_transfer_attempts;
drop trigger if exists stamp_intercompany_ledger_pilot on public.intercompany_transfer_ledger_lines;
drop function if exists public.stamp_intercompany_pilot_ownership();
drop function if exists public.finish_mfg_cross_store_transfer_draft(bigint,uuid);
drop function if exists public.assert_manufacturing_pilot_transfer_action(uuid,bigint,text);
alter table public.intercompany_transfer_attempts drop column pilot_work_order_id,drop column pilot_identifier;
alter table public.intercompany_transfer_ledger_lines drop column pilot_work_order_id,drop column pilot_identifier;
-- Restore the validated Phase 2.1 functions by reapplying migration 20260902160000.
commit;
