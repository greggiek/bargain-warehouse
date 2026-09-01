-- Rollback for 20260901093000_shopify_inventory_cache_ingestion.sql
drop function if exists public.upsert_shopify_inventory_cache_page(text,jsonb);
