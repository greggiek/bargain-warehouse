-- Manufacturing Shadow Mode. Qoblex remains operational authority.
-- This migration only adds access controls; it does not mutate work orders or inventory.

alter table public.mfg_feature_flags
  drop constraint if exists mfg_feature_flags_flag_key_check;
alter table public.mfg_feature_flags
  add constraint mfg_feature_flags_flag_key_check check(flag_key in (
    'manufacturing_v2','manufacturing_view_enabled','manufacturing_draft_enabled',
    'manufacturing_release_enabled','manufacturing_completion_enabled',
    'manufacturing_transfer_handoff_enabled','manufacturing_shopify_outbound_enabled'
  ));

insert into public.mfg_feature_flags(flag_key,enabled,notes)
values
  ('manufacturing_view_enabled',true,'Shadow Mode: approved beta users may view comparisons'),
  ('manufacturing_draft_enabled',true,'Shadow Mode: approved beta users may create non-operational drafts'),
  ('manufacturing_release_enabled',false,'Qoblex remains release authority'),
  ('manufacturing_completion_enabled',false,'Qoblex remains production transaction authority'),
  ('manufacturing_transfer_handoff_enabled',false,'No Manufacturing transfer handoff in Shadow Mode'),
  ('manufacturing_shopify_outbound_enabled',false,'No Manufacturing Shopify inventory mutation in Shadow Mode')
on conflict(flag_key) do update set enabled=excluded.enabled,notes=excluded.notes,updated_at=now();

create table if not exists public.mfg_beta_users (
  user_id bigint primary key references public.app_users(id) on delete cascade,
  active boolean not null default true,
  approved_by bigint references public.app_users(id) on delete set null,
  approval_reason text not null check (btrim(approval_reason)<>''),
  approved_at timestamptz not null default now(),
  revoked_by bigint references public.app_users(id) on delete set null,
  revoked_at timestamptz,
  notes text,
  check ((active and revoked_at is null) or not active)
);

alter table public.mfg_beta_users enable row level security;
revoke all on table public.mfg_beta_users from public,anon,authenticated;
grant select,insert,update,delete on table public.mfg_beta_users to service_role;

create or replace function public.mfg_feature_enabled_for_user(p_actor_user_id bigint,p_flag_key text)
returns boolean language sql stable security invoker set search_path='pg_catalog','public' as $$
  select exists(
    select 1
    from public.mfg_feature_flags f
    join public.mfg_beta_users b on b.user_id=p_actor_user_id and b.active
    join public.app_users u on u.id=b.user_id and u.active
    where f.flag_key=p_flag_key and f.enabled
  )
$$;

revoke all on function public.mfg_feature_enabled_for_user(bigint,text) from public,anon,authenticated;
grant execute on function public.mfg_feature_enabled_for_user(bigint,text) to service_role;

comment on table public.mfg_beta_users is 'BM-owned Manufacturing Shadow Mode allow-list. Catalog sync must not modify it.';
comment on function public.mfg_feature_enabled_for_user(bigint,text) is 'Requires an enabled feature flag, active beta approval, and active BM user.';
