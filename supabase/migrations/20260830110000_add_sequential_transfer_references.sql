create sequence if not exists public.bm_transfer_reference_seq start with 1 increment by 1;

create or replace function public.next_bm_transfer_reference()
returns text
language sql
volatile
set search_path = public
as $$ select lpad(nextval('public.bm_transfer_reference_seq')::text, 5, '0') $$;

revoke all on function public.next_bm_transfer_reference() from public;
grant execute on function public.next_bm_transfer_reference() to service_role;
