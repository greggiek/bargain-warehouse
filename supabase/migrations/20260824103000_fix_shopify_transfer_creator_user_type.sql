begin;

-- app_users uses bigint IDs; transfer links record the warehouse
-- employee who initiated the native Shopify draft.
alter table public.shopify_transfer_links
  alter column created_by_user_id type bigint
  using null;

comment on column public.shopify_transfer_links.created_by_user_id is
  'BM Warehouse app_users.id that created the linked Shopify transfer.';

commit;
