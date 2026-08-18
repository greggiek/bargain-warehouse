-- Normalize the transfer workflow without changing completed or exception records.
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
