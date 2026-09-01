-- Rollback for 20260901091500_forecasting_cache_ingestion.sql
drop function if exists public.finalize_shopify_sales_sync_job(uuid);
drop function if exists public.upsert_shopify_sales_dedup_page(text,jsonb);
