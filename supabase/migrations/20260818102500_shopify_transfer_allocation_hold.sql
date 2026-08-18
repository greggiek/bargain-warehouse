alter table public.shopify_transfer_writebacks
  drop constraint if exists shopify_transfer_writebacks_leg_check;

alter table public.shopify_transfer_writebacks
  add constraint shopify_transfer_writebacks_leg_check
  check (leg in ('allocate','release','receive'));

comment on table public.shopify_transfer_writebacks is
  'Idempotent Shopify allocation, release, and receipt ledger for the allowlisted Annex-to-Bohemia GREGS SHOES transfer test.';
