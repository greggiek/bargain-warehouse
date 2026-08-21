-- Shopify sales mirror for fast 30/60/90-day purchasing forecasts.
create table if not exists public.shopify_sales_daily (
  sales_date date not null,
  product_id bigint not null references public.products(id) on delete cascade,
  store_key text not null,
  quantity_sold numeric not null default 0 check (quantity_sold >= 0),
  order_count integer not null default 0 check (order_count >= 0),
  gross_sales numeric not null default 0 check (gross_sales >= 0),
  last_synced_at timestamptz not null default now(),
  primary key (sales_date, product_id, store_key)
);
create index if not exists shopify_sales_daily_product_date_idx on public.shopify_sales_daily (product_id, sales_date desc);
create index if not exists shopify_sales_daily_date_idx on public.shopify_sales_daily (sales_date desc);
alter table public.shopify_sales_daily enable row level security;
revoke all on table public.shopify_sales_daily from anon, authenticated;
grant select, insert, update, delete on table public.shopify_sales_daily to service_role;
