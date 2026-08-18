create table if not exists public.shopify_transfer_writebacks (
  id uuid primary key,
  transfer_id uuid not null references public.transfers(id) on delete cascade,
  transfer_line_id uuid not null references public.transfer_lines(id) on delete cascade,
  transfer_number text not null,
  sku text not null,
  leg text not null check (leg in ('ship','receive')),
  quantity_delta integer not null check (quantity_delta in (-1,1)),
  source_store text not null,
  source_store_label text,
  shopify_inventory_item_id text not null,
  shopify_location_id text not null,
  shopify_location_name text not null,
  status text not null default 'pending' check (status in ('pending','success','failed')),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  shopify_response jsonb,
  triggered_by_name text,
  triggered_by_email text,
  pushed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (transfer_line_id, leg)
);

create index if not exists shopify_transfer_writebacks_transfer_idx
  on public.shopify_transfer_writebacks (transfer_id, created_at desc);

alter table public.shopify_transfer_writebacks enable row level security;
revoke all on table public.shopify_transfer_writebacks from anon, authenticated;
grant all on table public.shopify_transfer_writebacks to service_role;

comment on table public.shopify_transfer_writebacks is
  'Idempotent two-leg Shopify inventory ledger for the single allowlisted Annex-to-Bohemia GREGS SHOES transfer test.';
