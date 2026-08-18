begin;

create schema if not exists private;

create table public.app_users (
  id bigint generated always as identity primary key,
  auth_user_id uuid unique references auth.users(id) on delete set null,
  display_name text not null check (length(trim(display_name)) > 0),
  email text check (email is null or email = lower(email)),
  role text not null default 'viewer' check (role in ('developer','admin','manager','warehouse','door_shop','viewer')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index app_users_email_key on public.app_users (lower(email)) where email is not null;
create index app_users_auth_user_id_idx on public.app_users(auth_user_id) where auth_user_id is not null;

create table public.warehouses (
  id bigint generated always as identity primary key,
  code text not null unique check (length(trim(code)) > 0),
  name text not null check (length(trim(name)) > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.locations (
  id bigint generated always as identity primary key,
  warehouse_id bigint not null references public.warehouses(id) on delete restrict,
  code text not null check (length(trim(code)) > 0),
  name text not null check (length(trim(name)) > 0),
  location_type text not null default 'warehouse'
    check (location_type in ('warehouse','retail','production','staging','damaged','receiving','shipping')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (warehouse_id, code)
);
create index locations_warehouse_id_idx on public.locations(warehouse_id);

create table public.user_location_access (
  user_id bigint not null references public.app_users(id) on delete cascade,
  location_id bigint not null references public.locations(id) on delete cascade,
  can_view boolean not null default true,
  can_adjust boolean not null default false,
  can_transfer boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (user_id, location_id)
);
create index user_location_access_location_id_idx on public.user_location_access(location_id);

create table public.products (
  id bigint generated always as identity primary key,
  sku text not null check (length(trim(sku)) > 0),
  name text not null check (length(trim(name)) > 0),
  barcode text,
  uom text not null default 'each',
  category text,
  active boolean not null default true,
  purchase_price numeric(14,4) check (purchase_price is null or purchase_price >= 0),
  moving_average_cost numeric(14,4) check (moving_average_cost is null or moving_average_cost >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index products_sku_key on public.products (upper(trim(sku)));
create unique index products_barcode_key on public.products(barcode) where barcode is not null;
create index products_active_idx on public.products(active);

create table public.vendors (
  id bigint generated always as identity primary key,
  code text,
  name text not null check (length(trim(name)) > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index vendors_code_key on public.vendors (upper(trim(code))) where code is not null;
create index vendors_name_idx on public.vendors(lower(name));

create table public.inventory_balances (
  product_id bigint not null references public.products(id) on delete restrict,
  location_id bigint not null references public.locations(id) on delete restrict,
  quantity numeric(16,4) not null default 0 check (quantity >= 0),
  allocated_quantity numeric(16,4) not null default 0
    check (allocated_quantity >= 0 and allocated_quantity <= quantity),
  updated_at timestamptz not null default now(),
  primary key (product_id, location_id)
);
create index inventory_balances_location_id_idx on public.inventory_balances(location_id);

create table public.inventory_movements (
  id bigint generated always as identity primary key,
  product_id bigint not null references public.products(id) on delete restrict,
  location_id bigint not null references public.locations(id) on delete restrict,
  movement_type text not null check (movement_type in (
    'opening_balance','purchase_receipt','transfer_ship','transfer_receive',
    'production_consume','production_complete','cycle_count','adjustment',
    'damage','return','allocation','allocation_release'
  )),
  quantity_delta numeric(16,4) not null check (quantity_delta <> 0),
  quantity_before numeric(16,4) not null check (quantity_before >= 0),
  quantity_after numeric(16,4) not null check (quantity_after >= 0),
  unit_cost numeric(14,4) check (unit_cost is null or unit_cost >= 0),
  reference_type text,
  reference_id text,
  reason text,
  idempotency_key text not null unique,
  performed_by_user_id bigint references public.app_users(id) on delete set null,
  performed_by_name text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (quantity_after = quantity_before + quantity_delta)
);
create index inventory_movements_product_location_created_idx
  on public.inventory_movements(product_id, location_id, created_at desc);
create index inventory_movements_location_created_idx
  on public.inventory_movements(location_id, created_at desc);
create index inventory_movements_reference_idx
  on public.inventory_movements(reference_type, reference_id)
  where reference_type is not null and reference_id is not null;

create table public.activity_events (
  id bigint generated always as identity primary key,
  user_id bigint references public.app_users(id) on delete set null,
  user_name text,
  user_email text,
  action_type text not null,
  document_type text,
  document_id text,
  warehouse_id bigint references public.warehouses(id) on delete set null,
  description text not null,
  status text not null default 'success' check (status in ('success','failed','warning','info')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index activity_events_created_at_idx on public.activity_events(created_at desc);
create index activity_events_user_id_idx on public.activity_events(user_id);
create index activity_events_document_idx on public.activity_events(document_type, document_id)
  where document_type is not null and document_id is not null;
create index activity_events_warehouse_id_idx on public.activity_events(warehouse_id);

create or replace function private.set_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger app_users_set_updated_at before update on public.app_users
for each row execute function private.set_updated_at();
create trigger warehouses_set_updated_at before update on public.warehouses
for each row execute function private.set_updated_at();
create trigger locations_set_updated_at before update on public.locations
for each row execute function private.set_updated_at();
create trigger products_set_updated_at before update on public.products
for each row execute function private.set_updated_at();
create trigger vendors_set_updated_at before update on public.vendors
for each row execute function private.set_updated_at();

create or replace function private.prevent_inventory_movement_mutation()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception 'inventory movements are immutable';
end;
$$;

create trigger inventory_movements_immutable
before update or delete on public.inventory_movements
for each row execute function private.prevent_inventory_movement_mutation();

create or replace function public.post_inventory_movement(
  p_product_id bigint,
  p_location_id bigint,
  p_movement_type text,
  p_quantity_delta numeric,
  p_idempotency_key text,
  p_unit_cost numeric default null,
  p_reference_type text default null,
  p_reference_id text default null,
  p_reason text default null,
  p_performed_by_user_id bigint default null,
  p_performed_by_name text default null,
  p_metadata jsonb default '{}'::jsonb
) returns public.inventory_movements
language plpgsql security invoker set search_path = '' as $$
declare
  v_before numeric(16,4);
  v_after numeric(16,4);
  v_movement public.inventory_movements;
begin
  if p_quantity_delta = 0 then
    raise exception 'quantity delta cannot be zero';
  end if;

  insert into public.inventory_balances(product_id, location_id, quantity)
  values (p_product_id, p_location_id, 0)
  on conflict (product_id, location_id) do nothing;

  select quantity into v_before
  from public.inventory_balances
  where product_id = p_product_id and location_id = p_location_id
  for update;

  v_after := v_before + p_quantity_delta;
  if v_after < 0 then
    raise exception 'inventory cannot become negative';
  end if;

  update public.inventory_balances
  set quantity = v_after, updated_at = now()
  where product_id = p_product_id and location_id = p_location_id;

  insert into public.inventory_movements(
    product_id, location_id, movement_type, quantity_delta,
    quantity_before, quantity_after, unit_cost, reference_type,
    reference_id, reason, idempotency_key, performed_by_user_id,
    performed_by_name, metadata
  ) values (
    p_product_id, p_location_id, p_movement_type, p_quantity_delta,
    v_before, v_after, p_unit_cost, p_reference_type,
    p_reference_id, p_reason, p_idempotency_key, p_performed_by_user_id,
    p_performed_by_name, coalesce(p_metadata, '{}'::jsonb)
  ) returning * into v_movement;

  return v_movement;
exception
  when unique_violation then
    select * into v_movement from public.inventory_movements
    where idempotency_key = p_idempotency_key;
    if found then return v_movement; end if;
    raise;
end;
$$;

revoke all on function public.post_inventory_movement(bigint,bigint,text,numeric,text,numeric,text,text,text,bigint,text,jsonb)
from public, anon, authenticated;
grant execute on function public.post_inventory_movement(bigint,bigint,text,numeric,text,numeric,text,text,text,bigint,text,jsonb)
to service_role;

alter table public.app_users enable row level security;
alter table public.warehouses enable row level security;
alter table public.locations enable row level security;
alter table public.user_location_access enable row level security;
alter table public.products enable row level security;
alter table public.vendors enable row level security;
alter table public.inventory_balances enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.activity_events enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

insert into public.warehouses(code, name) values
  ('AMT', 'Amityville'),
  ('BOH', 'Bohemia'),
  ('OUT', 'Outpost - Ronkonkoma'),
  ('RIV', 'Riverhead'),
  ('WIN', 'Windham')
on conflict (code) do update set name = excluded.name, active = true;

insert into public.locations(warehouse_id, code, name, location_type)
select w.id, seed.code, seed.name, 'warehouse'
from (values
  ('AMT', 'MAIN', 'Amityville Main'),
  ('BOH', 'MAIN', 'Bohemia Main'),
  ('OUT', 'MAIN', 'Outpost - Ronkonkoma'),
  ('RIV', 'MAIN', 'Riverhead Main'),
  ('WIN', '730', '730 Windham Rd'),
  ('WIN', 'ANNEX', 'Annex Warehouse')
) as seed(warehouse_code, code, name)
join public.warehouses w on w.code = seed.warehouse_code
on conflict (warehouse_id, code) do update
set name = excluded.name, location_type = excluded.location_type, active = true;

commit;
