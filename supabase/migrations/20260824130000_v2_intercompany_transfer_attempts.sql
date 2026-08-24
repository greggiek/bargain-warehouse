begin;

create table if not exists public.intercompany_transfer_attempts (
  id uuid primary key default gen_random_uuid(),
  transfer_link_id uuid not null references public.shopify_transfer_links(id) on delete cascade,
  leg text not null check (leg in ('ship','receive')),
  idempotency_key uuid not null default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending','shopify_confirmed','applied','failed')),
  shopify_adjustment_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (transfer_link_id, leg),
  unique (idempotency_key)
);

create index if not exists intercompany_transfer_attempts_link_status_idx
  on public.intercompany_transfer_attempts (transfer_link_id, status);

alter table public.intercompany_transfer_attempts enable row level security;
revoke all on table public.intercompany_transfer_attempts from anon, authenticated;
grant select, insert, update, delete on table public.intercompany_transfer_attempts to service_role;

comment on table public.intercompany_transfer_attempts is
  'Internal idempotent audit records for the outbound and inbound Shopify inventory adjustments of a BM Warehouse cross-store transfer.';

commit;