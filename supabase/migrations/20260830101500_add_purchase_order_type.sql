-- Classify purchase orders by procurement lead time.
alter table public.purchase_orders
  add column if not exists purchase_type text not null default 'local_buy';

do $$
begin
  alter table public.purchase_orders
    add constraint purchase_orders_purchase_type_check
    check (purchase_type in ('container_buy', 'local_buy'));
exception when duplicate_object then null;
end $$;