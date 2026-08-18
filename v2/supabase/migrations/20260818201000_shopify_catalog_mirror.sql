-- Shopify remains the system of record. This table holds only stable source identities
-- for V2's one-way catalog mirror; it is not exposed to browser roles.
create table public.product_shopify_sources (
  id bigint generated always as identity primary key,
  product_id bigint not null references public.products(id) on delete cascade,
  store_key text not null check (store_key in ('store_1', 'store_2')),
  shopify_product_id text not null check (length(trim(shopify_product_id)) > 0),
  shopify_variant_id text not null check (length(trim(shopify_variant_id)) > 0),
  shopify_inventory_item_id text,
  last_synced_at timestamptz not null default now(),
  constraint product_shopify_sources_store_variant_unique unique (store_key, shopify_variant_id)
);

create index product_shopify_sources_product_id_idx
  on public.product_shopify_sources(product_id);

alter table public.product_shopify_sources enable row level security;
revoke all on table public.product_shopify_sources from anon, authenticated;
grant all on table public.product_shopify_sources to service_role;
