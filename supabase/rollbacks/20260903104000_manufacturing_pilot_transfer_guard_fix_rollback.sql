begin;
do $$ begin
 if exists(select 1 from public.shopify_transfer_links where pilot_identifier is not null)
 then raise exception 'pilot_transfer_guard_rollback_blocked_pilot_transfer_exists';end if;
end $$;
-- Keep the corrected fail-closed guard; rollback only reasserts disabled state.
update public.manufacturing_pilot_gate set enabled=false where pilot_identifier='BM-MFG-PILOT-001';
update public.mfg_feature_flags set enabled=false,updated_at=now() where flag_key like 'manufacturing_pilot_%';
commit;
