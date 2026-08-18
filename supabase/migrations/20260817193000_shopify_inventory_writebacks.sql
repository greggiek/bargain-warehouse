create table if not exists public.shopify_inventory_writebacks (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid references public.purchase_orders(id) on delete set null,
  po_number text not null,
  product_id uuid references public.products(id) on delete set null,
  sku text not null,
  quantity_delta numeric(14,4) not null check (quantity_delta > 0),
  warehouse_location text not null,
  source_store text not null,
  source_store_label text not null,
  shopify_inventory_item_id text not null,
  shopify_location_id text not null,
  shopify_location_name text not null,
  status text not null default 'pending' check (status in ('pending','success','failed','unmatched')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  shopify_response jsonb,
  triggered_by_name text,
  triggered_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  pushed_at timestamptz
);

create index if not exists shopify_inventory_writebacks_status_idx
  on public.shopify_inventory_writebacks(status, updated_at desc);
create index if not exists shopify_inventory_writebacks_purchase_order_idx
  on public.shopify_inventory_writebacks(purchase_order_id)
  where purchase_order_id is not null;
create index if not exists shopify_inventory_writebacks_sku_idx
  on public.shopify_inventory_writebacks(sku, created_at desc);

alter table public.shopify_inventory_writebacks enable row level security;
revoke all on public.shopify_inventory_writebacks from anon, authenticated;
grant all on public.shopify_inventory_writebacks to service_role;

comment on table public.shopify_inventory_writebacks is
  'Durable idempotent audit and retry queue for PO receipt quantities sent to one mapped Shopify location.';
