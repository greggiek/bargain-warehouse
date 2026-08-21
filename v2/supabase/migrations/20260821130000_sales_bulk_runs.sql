create table if not exists public.shopify_sales_bulk_runs (
  id uuid primary key default gen_random_uuid(),
  window_start date not null,
  window_end date not null,
  status text not null default 'running' check (status in ('running','completed','failed','imported')),
  store_1_operation_id text,
  store_2_operation_id text,
  store_1_url text,
  store_2_url text,
  error text,
  orders integer not null default 0,
  lines integer not null default 0,
  mirrored integer not null default 0,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  imported_at timestamptz
);
alter table public.shopify_sales_bulk_runs enable row level security;
revoke all on table public.shopify_sales_bulk_runs from anon, authenticated;
create index if not exists shopify_sales_bulk_runs_status_idx
  on public.shopify_sales_bulk_runs(status, created_at desc);
