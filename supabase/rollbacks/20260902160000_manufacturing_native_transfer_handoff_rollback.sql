begin;
drop function if exists public.cancel_mfg_transfer_handoff(bigint,bigint,text,text);
drop function if exists public.fail_mfg_transfer_handoff(bigint,uuid,text,boolean);
drop function if exists public.finish_mfg_transfer_handoff(bigint,uuid,text,text);
drop function if exists public.begin_mfg_transfer_handoff_link(bigint,uuid);
drop function if exists public.claim_mfg_transfer_handoff(integer);
drop function if exists public.refresh_mfg_transfer_handoff(bigint);
drop trigger if exists guard_mfg_transfer_handoff_transition on public.mfg_transfer_handoffs;
drop function if exists public.guard_mfg_transfer_handoff_transition();
drop function if exists public.mfg_handoff_transition_allowed(text,text);
alter table public.mfg_planned_transfers drop column if exists shopify_transfer_link_id;
alter table public.shopify_transfer_links drop constraint if exists shopify_transfer_links_manufacturing_handoff_fkey;
alter table public.shopify_transfer_links drop column if exists manufacturing_handoff_id;
drop table if exists public.mfg_transfer_handoff_inventory_adjustments;
drop table if exists public.mfg_transfer_handoff_lines;
drop table if exists public.mfg_transfer_handoffs;
-- Reapply the Phase 2 complete/close definitions after rollback.
commit;
