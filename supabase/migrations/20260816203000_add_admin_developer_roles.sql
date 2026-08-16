alter table public.warehouse_app_users
  drop constraint if exists warehouse_app_users_role_check,
  drop constraint if exists warehouse_app_users_auth_mode_check,
  drop constraint if exists warehouse_app_users_check;

alter table public.warehouse_app_users
  add constraint warehouse_app_users_role_check
    check (role in ('administrator','developer','logistics_coordinator','warehouse_manager','warehouse_employee')),
  add constraint warehouse_app_users_auth_mode_check
    check (auth_mode in ('google_workspace','google_external','pin')),
  add constraint warehouse_app_users_identity_check
    check (((auth_mode in ('google_workspace','google_external')) and email is not null and username is null and pin_hash is null) or (auth_mode='pin' and username is not null and pin_hash is not null));

update public.warehouse_app_users
set role = 'administrator', location = null, updated_at = now()
where lower(email) = 'greg@bargainmoulding.com' and active = true;

insert into public.warehouse_app_users
  (display_name,email,auth_mode,role,location,active,created_by_email)
values
  ('Jennifer Weber','weber.jennifer@gmail.com','google_external','developer',null,true,'greg@bargainmoulding.com')
on conflict (email) do update
set display_name = excluded.display_name,
    auth_mode = excluded.auth_mode,
    role = excluded.role,
    location = null,
    active = true,
    updated_at = now();
