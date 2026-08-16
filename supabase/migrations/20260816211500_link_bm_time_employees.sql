alter table public.warehouse_app_users
  add column if not exists bm_time_employee_id text;

create unique index if not exists warehouse_app_users_bm_time_employee_unique
  on public.warehouse_app_users (bm_time_employee_id)
  where bm_time_employee_id is not null;

comment on column public.warehouse_app_users.bm_time_employee_id is
  'Optional link to the active employee record in BM Time; identifiers are resolved server-side only.';
