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

update public.warehouse_app_users
set display_name = 'Jennifer Weber',
    auth_mode = 'google_external',
    role = 'developer',
    location = null,
    active = true,
    updated_at = now()
where lower(email) = 'weber.jennifer@gmail.com';

insert into public.warehouse_app_users
  (display_name,email,auth_mode,role,location,active,created_by_email)
select 'Jennifer Weber','weber.jennifer@gmail.com','google_external','developer',null,true,'greg@bargainmoulding.com'
where not exists (
  select 1 from public.warehouse_app_users where lower(email) = 'weber.jennifer@gmail.com'
);
