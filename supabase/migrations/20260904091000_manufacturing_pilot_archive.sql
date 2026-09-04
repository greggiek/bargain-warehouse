begin;

alter table public.manufacturing_pilot_gate
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by_user_id bigint references public.app_users(id) on delete restrict,
  add column if not exists archive_reason text;

comment on column public.manufacturing_pilot_gate.archived_at is
  'Permanent retirement timestamp; the immutable approved work-order binding is retained for audit.';

commit;
