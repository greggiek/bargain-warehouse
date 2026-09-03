begin;
-- Retain the safe idempotency ordering; rollback only reasserts disabled state.
update public.manufacturing_pilot_gate set enabled=false where pilot_identifier='BM-MFG-PILOT-001';
update public.mfg_feature_flags set enabled=false,updated_at=now() where flag_key like 'manufacturing_pilot_%';
commit;
