begin;

do $$
begin
  if exists(select 1 from public.manufacturing_pilot_gate where archived_at is not null) then
    raise exception 'rollback_blocked_pilot_archive_evidence_exists';
  end if;
end $$;

alter table public.manufacturing_pilot_gate
  drop column if exists archive_reason,
  drop column if exists archived_by_user_id,
  drop column if exists archived_at;

commit;
