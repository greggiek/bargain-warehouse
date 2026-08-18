alter table public.shopify_transfer_writebacks
  add column if not exists change_from_quantity integer;

alter table public.shopify_transfer_writebacks
  drop constraint if exists shopify_transfer_writebacks_leg_check;

alter table public.shopify_transfer_writebacks
  add constraint shopify_transfer_writebacks_leg_check
  check (leg in ('ship','allocate','release','receive'));

comment on column public.shopify_transfer_writebacks.change_from_quantity is
  'Shopify compare-and-set available quantity captured before the first idempotent adjustment attempt.';

comment on table public.shopify_transfer_writebacks is
  'Idempotent Shopify allocation, release, and receipt ledger for the allowlisted Annex-to-Bohemia GREGS SHOES transfer test.';
