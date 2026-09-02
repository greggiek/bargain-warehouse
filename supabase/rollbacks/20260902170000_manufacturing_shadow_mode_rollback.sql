revoke all on function public.mfg_feature_enabled_for_user(bigint,text) from public,anon,authenticated,service_role;
drop function if exists public.mfg_feature_enabled_for_user(bigint,text);
revoke all on table public.mfg_beta_users from public,anon,authenticated,service_role;
drop table if exists public.mfg_beta_users;

delete from public.mfg_feature_flags where flag_key in (
  'manufacturing_view_enabled','manufacturing_draft_enabled','manufacturing_release_enabled',
  'manufacturing_completion_enabled','manufacturing_transfer_handoff_enabled','manufacturing_shopify_outbound_enabled'
);
update public.mfg_feature_flags set enabled=false,notes='Shadow Mode rollback; Manufacturing disabled',updated_at=now()
where flag_key='manufacturing_v2';
alter table public.mfg_feature_flags drop constraint if exists mfg_feature_flags_flag_key_check;
alter table public.mfg_feature_flags add constraint mfg_feature_flags_flag_key_check check(flag_key='manufacturing_v2');
