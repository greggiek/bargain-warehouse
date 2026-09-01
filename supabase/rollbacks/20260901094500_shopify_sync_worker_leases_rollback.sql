-- Rollback for 20260901094500_shopify_sync_worker_leases.sql
drop function if exists public.release_shopify_sync_job(uuid,uuid);
drop function if exists public.claim_shopify_sync_job(uuid,integer);
alter table public.shopify_sync_jobs
  drop column if exists lease_token,
  drop column if exists lease_expires_at;
