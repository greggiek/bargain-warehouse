-- Normalize the transfer workflow without changing completed or exception records.
alter table public.transfer_lines
  add column if not exists damaged_qty numeric not null default 0 check (damaged_qty >= 0),
  add column if not exists missing_qty numeric not null default 0 check (missing_qty >= 0);

update public.transfer_lines
set missing_qty = greatest(0, shipped_qty - received_qty);

alter table public.transfers
  add column if not exists allocated_at timestamptz,
  add column if not exists allocated_by_name text,
  add column if not exists allocated_by_email text,
  add column if not exists shipped_by_name text,
  add column if not exists shipped_by_email text,
  add column if not exists canceled_at timestamptz,
  add column if not exists canceled_by_name text,
  add column if not exists canceled_by_email text;

update public.transfers
set status = 'in_transit',
    shipped_at = coalesce(shipped_at, updated_at),
    updated_at = now()
where status in ('awaiting_receipt', 'receiving');

create index if not exists transfers_active_lifecycle_idx
  on public.transfers(status, updated_at desc)
  where status not in ('completed', 'canceled', 'closed_short', 'closed_adjusted');

comment on column public.transfers.status is
  'Transfer lifecycle: draft, allocated, in_transit, partially_received, completed, canceled; exception statuses remain available for logistics review.';

comment on column public.transfer_lines.damaged_qty is
  'Quantity physically received but reported damaged for this SKU.';
comment on column public.transfer_lines.missing_qty is
  'Shipped quantity not yet received for this SKU.';
