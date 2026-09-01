-- Short worker leases prevent concurrent serverless invocations from processing the same sync job.

alter table public.shopify_sync_jobs
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz;

create or replace function public.claim_shopify_sync_job(
  p_job_id uuid,
  p_lease_seconds integer default 240
) returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.shopify_sync_jobs%rowtype;
  v_token uuid := gen_random_uuid();
begin
  if p_lease_seconds < 30 or p_lease_seconds > 300 then
    raise exception 'Lease must be between 30 and 300 seconds';
  end if;

  select * into v_job
    from public.shopify_sync_jobs
   where id = p_job_id
   for update;

  if v_job.id is null then raise exception 'Shopify sync job not found'; end if;
  if v_job.status not in ('queued','running') then raise exception 'Shopify sync job is not active'; end if;
  if v_job.lease_expires_at is not null and v_job.lease_expires_at > now() then
    raise exception 'Shopify sync job is already claimed';
  end if;

  update public.shopify_sync_jobs
     set lease_token = v_token,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         status = 'running',
         updated_at = now()
   where id = p_job_id;

  return v_token;
end;
$$;

create or replace function public.release_shopify_sync_job(
  p_job_id uuid,
  p_lease_token uuid
) returns boolean
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  update public.shopify_sync_jobs
     set lease_token = null,
         lease_expires_at = null,
         updated_at = now()
   where id = p_job_id
     and lease_token = p_lease_token;
  return found;
end;
$$;

revoke all on function public.claim_shopify_sync_job(uuid,integer) from public, anon, authenticated;
revoke all on function public.release_shopify_sync_job(uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_shopify_sync_job(uuid,integer) to service_role;
grant execute on function public.release_shopify_sync_job(uuid,uuid) to service_role;
