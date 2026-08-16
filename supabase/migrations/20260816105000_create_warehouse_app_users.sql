create table if not exists public.warehouse_app_users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique,
  display_name text not null,
  email text,
  username text,
  auth_mode text not null check (auth_mode in ('google_workspace','pin')),
  role text not null check (role in ('logistics_coordinator','warehouse_manager','warehouse_employee')),
  location text,
  pin_hash text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_email text,
  check ((auth_mode='google_workspace' and email is not null and username is null and pin_hash is null) or (auth_mode='pin' and username is not null and pin_hash is not null))
);
create unique index if not exists warehouse_app_users_email_unique on public.warehouse_app_users (lower(email)) where email is not null;
create unique index if not exists warehouse_app_users_username_unique on public.warehouse_app_users (lower(username)) where username is not null;
alter table public.warehouse_app_users enable row level security;
revoke all on public.warehouse_app_users from anon, authenticated;
comment on table public.warehouse_app_users is 'Server-managed BM Warehouse application identities and role assignments. PIN hashes are never exposed through client APIs.';
