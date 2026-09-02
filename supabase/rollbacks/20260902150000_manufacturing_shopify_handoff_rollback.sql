begin;
drop trigger if exists enqueue_mfg_shopify_inventory_adjustment on public.inventory_movements;
drop function if exists public.enqueue_mfg_shopify_inventory_adjustment();
drop function if exists public.claim_mfg_shopify_inventory_adjustment(integer);
drop function if exists public.prepare_mfg_shopify_inventory_adjustment(bigint,uuid,numeric);
drop function if exists public.confirm_mfg_shopify_inventory_adjustment(bigint,uuid,text);
drop function if exists public.fail_mfg_shopify_inventory_adjustment(bigint,uuid,text);
drop table if exists public.mfg_shopify_inventory_adjustments;
drop table if exists public.mfg_shopify_inventory_routes;
-- Reapply 20260901123000_restore_signed_inventory_quantities.sql to restore the
-- pre-handoff signed reconciliation function before using this rollback.
commit;
