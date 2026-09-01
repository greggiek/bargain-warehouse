-- Lean, rebuildable Shopify forecasting cache for BM Warehouse V2.
-- Additive only: existing shopify_sales_daily rows and the current Forecasting implementation remain intact.

alter table public.shopify_sales_daily
  add column if not exists sku text,
  add column if not exists gross_fulfilled_quantity numeric(16,4),
  add column if not exists source_updated_at timestamptz;

comment on table public.shopify_sales_daily is
  'Disposable rolling Shopify sales aggregate cache. Shopify remains authoritative. Retain 120 days after validated backfill.';
comment on column public.shopify_sales_daily.quantity_sold is
  'Legacy aggregate retained during cutover. New forecasting uses gross_fulfilled_quantity only after store/day coverage is validated.';

create table if not exists public.shopify_inventory_cache (
  store_key text not null check (store_key in ('store_1','store_2')),
  shopify_location_id text not null,
  shopify_inventory_item_id text not null,
  shopify_variant_id text,
  product_id bigint references public.products(id) on delete set null,
  sku text not null check (length(btrim(sku)) > 0),
  on_hand_quantity numeric(16,4) not null default 0,
  available_quantity numeric(16,4) not null default 0,
  committed_quantity numeric(16,4) not null default 0,
  source_updated_at timestamptz,
  last_synchronized_at timestamptz not null default now(),
  primary key (store_key, shopify_location_id, shopify_inventory_item_id)
);
create index if not exists shopify_inventory_cache_product_location_idx
  on public.shopify_inventory_cache(product_id, shopify_location_id);
create index if not exists shopify_inventory_cache_stocked_idx
  on public.shopify_inventory_cache(product_id)
  where available_quantity > 0;
comment on table public.shopify_inventory_cache is
  'Current disposable Shopify inventory snapshot. Overwrite in place; do not retain inventory history.';

create table if not exists public.shopify_sales_dedup (
  store_key text not null check (store_key in ('store_1','store_2')),
  shopify_order_id text not null,
  shopify_line_id text not null,
  sales_date date not null,
  product_id bigint references public.products(id) on delete set null,
  sku text not null check (length(btrim(sku)) > 0),
  gross_fulfilled_quantity numeric(16,4) not null check (gross_fulfilled_quantity >= 0),
  shopify_updated_at timestamptz not null,
  last_synchronized_at timestamptz not null default now(),
  primary key (store_key, shopify_order_id, shopify_line_id)
);
create index if not exists shopify_sales_dedup_sales_date_idx
  on public.shopify_sales_dedup(sales_date);
create index if not exists shopify_sales_dedup_product_date_idx
  on public.shopify_sales_dedup(product_id, sales_date desc);
comment on table public.shopify_sales_dedup is
  'Compact rolling 120-day fulfilled-line identity cache. Contains no customer, address, payment, or full order payload data.';

create table if not exists public.shopify_sales_coverage (
  store_key text not null check (store_key in ('store_1','store_2')),
  sales_date date not null,
  status text not null check (status in ('pending','completed_with_sales','completed_zero_sales','failed','missing')),
  gross_fulfilled_quantity numeric(16,4) not null default 0,
  order_count integer not null default 0 check (order_count >= 0),
  fulfillment_line_count integer not null default 0 check (fulfillment_line_count >= 0),
  completed_at timestamptz,
  last_error text,
  last_synchronized_at timestamptz not null default now(),
  primary key (store_key, sales_date),
  check (
    (status in ('completed_with_sales','completed_zero_sales') and completed_at is not null and last_error is null)
    or status in ('pending','failed','missing')
  )
);
create index if not exists shopify_sales_coverage_status_date_idx
  on public.shopify_sales_coverage(status, sales_date desc);
comment on table public.shopify_sales_coverage is
  'Rolling store/day proof for Forecasting. Explicitly distinguishes zero-sales completion from missing or failed synchronization.';

create table if not exists public.shopify_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  store_key text not null check (store_key in ('store_1','store_2')),
  job_type text not null check (job_type in ('sales_backfill','sales_incremental','inventory_snapshot','cache_cleanup')),
  status text not null default 'queued' check (status in ('queued','running','completed','failed','cancelled')),
  window_start date,
  window_end date,
  cursor text,
  checkpoint jsonb not null default '{}'::jsonb,
  processed_orders integer not null default 0 check (processed_orders >= 0),
  processed_fulfillment_lines integer not null default 0 check (processed_fulfillment_lines >= 0),
  duplicate_records_prevented integer not null default 0 check (duplicate_records_prevented >= 0),
  throttle_events integer not null default 0 check (throttle_events >= 0),
  retry_events integer not null default 0 check (retry_events >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists shopify_sync_jobs_one_active_idx
  on public.shopify_sync_jobs(store_key, job_type)
  where status in ('queued','running');
create index if not exists shopify_sync_jobs_status_created_idx
  on public.shopify_sync_jobs(status, created_at desc);
comment on table public.shopify_sync_jobs is
  'Short-lived operational job locks and checkpoints for disposable Shopify caches. Completed history expires after validation and retention activation.';

create or replace function public.begin_shopify_sync_job(
  p_store_key text,
  p_job_type text,
  p_window_start date default null,
  p_window_end date default null
) returns uuid
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
begin
  if p_store_key not in ('store_1','store_2') then
    raise exception 'Unknown Shopify store';
  end if;
  if p_job_type not in ('sales_backfill','sales_incremental','inventory_snapshot','cache_cleanup') then
    raise exception 'Unknown Shopify sync job type';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_store_key || ':' || p_job_type, 0));
  if exists (
    select 1 from public.shopify_sync_jobs
    where store_key = p_store_key
      and job_type = p_job_type
      and status in ('queued','running')
  ) then
    raise exception 'A % job is already active for %', p_job_type, p_store_key;
  end if;

  insert into public.shopify_sync_jobs(
    store_key, job_type, status, window_start, window_end, started_at
  ) values (
    p_store_key, p_job_type, 'running', p_window_start, p_window_end, now()
  ) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.cleanup_shopify_forecasting_cache(
  p_sales_retention_days integer default 120,
  p_job_retention_days integer default 60
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_sales_daily integer;
  v_dedup integer;
  v_coverage integer;
  v_jobs integer;
begin
  if p_sales_retention_days < 120 then
    raise exception 'Sales cache retention cannot be shorter than 120 days';
  end if;
  if p_job_retention_days < 30 or p_job_retention_days > 90 then
    raise exception 'Job retention must be between 30 and 90 days';
  end if;

  delete from public.shopify_sales_daily
   where sales_date < current_date - p_sales_retention_days;
  get diagnostics v_sales_daily = row_count;

  delete from public.shopify_sales_dedup
   where sales_date < current_date - p_sales_retention_days;
  get diagnostics v_dedup = row_count;

  delete from public.shopify_sales_coverage
   where sales_date < current_date - p_sales_retention_days;
  get diagnostics v_coverage = row_count;

  delete from public.shopify_sync_jobs
   where status in ('completed','cancelled')
     and completed_at < now() - make_interval(days => p_job_retention_days);
  get diagnostics v_jobs = row_count;

  return jsonb_build_object(
    'salesDailyDeleted', v_sales_daily,
    'dedupDeleted', v_dedup,
    'coverageDeleted', v_coverage,
    'jobsDeleted', v_jobs
  );
end;
$$;

-- Existing PO receipt attempts are BM Warehouse operational records.
-- These fields expose failed Shopify pushes without introducing another cache table.
alter table public.purchase_order_receipt_attempts
  add column if not exists last_error text,
  add column if not exists failed_at timestamptz;

alter table public.shopify_inventory_cache enable row level security;
alter table public.shopify_sales_dedup enable row level security;
alter table public.shopify_sales_coverage enable row level security;
alter table public.shopify_sync_jobs enable row level security;

revoke all on table public.shopify_inventory_cache from anon, authenticated;
revoke all on table public.shopify_sales_dedup from anon, authenticated;
revoke all on table public.shopify_sales_coverage from anon, authenticated;
revoke all on table public.shopify_sync_jobs from anon, authenticated;
revoke all on function public.begin_shopify_sync_job(text,text,date,date) from public, anon, authenticated;
revoke all on function public.cleanup_shopify_forecasting_cache(integer,integer) from public, anon, authenticated;
grant execute on function public.begin_shopify_sync_job(text,text,date,date) to service_role;
grant execute on function public.cleanup_shopify_forecasting_cache(integer,integer) to service_role;

-- Cleanup is intentionally NOT scheduled here. Activate only after the 120-day backfill validates.
