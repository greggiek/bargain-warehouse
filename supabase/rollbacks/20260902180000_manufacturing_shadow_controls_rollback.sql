update public.mfg_feature_flags set enabled=false,updated_at=now() where flag_key like 'manufacturing_%';
drop function if exists public.cancel_mfg_shadow_draft(bigint,bigint,text);drop table if exists public.mfg_beta_users;delete from public.mfg_feature_flags where flag_key<>'manufacturing_v2';
