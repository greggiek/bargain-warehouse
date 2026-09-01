-- Rollback for 20260901090000_forecasting_lean_cache.sql
-- Run only before the new Forecasting implementation is activated.
-- This intentionally preserves the pre-existing shopify_sales_daily table and its legacy data.

drop function if exists public.cleanup_shopify_forecasting_cache(integer, integer);
drop function if exists public.begin_shopify_sync_job(text, text, date, date);

drop table if exists public.shopify_sync_jobs;
drop table if exists public.shopify_sales_coverage;
drop table if exists public.shopify_sales_dedup;
drop table if exists public.shopify_inventory_cache;

alter table public.shopify_sales_daily
  drop column if exists sku,
  drop column if exists gross_fulfilled_quantity,
  drop column if exists source_updated_at;

alter table public.purchase_order_receipt_attempts
  drop column if exists last_error,
  drop column if exists failed_at;
