alter table public.shopify_transfer_links drop constraint if exists shopify_transfer_links_status_check;

alter table public.shopify_transfer_links
  add constraint shopify_transfer_links_status_check
  check (status = any (array[
    'draft', 'pending', 'received',
    'prepared', 'shipped', 'partially_received', 'completed', 'needs_review',
    'failed', 'cancelled'
  ]));
