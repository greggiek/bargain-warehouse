alter table public.mfg_feature_flags drop constraint if exists mfg_feature_flags_flag_key_check;
insert into public.mfg_feature_flags(flag_key,enabled,notes,updated_at) values
('manufacturing_view_enabled',true,'Shadow Mode views',now()),('manufacturing_draft_enabled',true,'Drafts have no inventory effect',now()),
('manufacturing_release_enabled',false,'Post-smoke authorization required',now()),('manufacturing_completion_enabled',false,'Post-smoke authorization required',now()),
('manufacturing_transfer_handoff_enabled',false,'Post-smoke authorization required',now()),('manufacturing_shopify_outbound_enabled',false,'Post-smoke authorization required',now()),
('manufacturing_inventory_mutations_enabled',false,'Post-smoke authorization required',now()),('manufacturing_v2',true,'Compatibility gate only',now())
on conflict(flag_key) do update set enabled=excluded.enabled,notes=excluded.notes,updated_at=now();
create table public.mfg_beta_users(user_id bigint primary key references public.app_users(id) on delete cascade,added_at timestamptz not null default now());
delete from public.mfg_beta_users;
insert into public.mfg_beta_users(user_id)
select id from public.app_users where active is true and lower(display_name) in ('gregory kleczka','edwin santos');
do $$ begin
  if (select count(*) from public.mfg_beta_users) <> 2 then
    raise exception 'Manufacturing beta allow-list must resolve exactly Gregory Kleczka and Edwin Santos';
  end if;
end $$;
alter table public.mfg_beta_users enable row level security;revoke all on public.mfg_beta_users from public,anon,authenticated;grant all on public.mfg_beta_users to service_role;
create or replace function public.cancel_mfg_shadow_draft(p_actor_user_id bigint,p_work_order_id bigint,p_idempotency_key text) returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare w public.mfg_work_orders%rowtype;r jsonb;begin select * into w from public.mfg_work_orders where id=p_work_order_id for update;if not found then raise exception 'work_order_not_found';end if;if w.status='Cancelled' and w.cancellation_idempotency_key=p_idempotency_key then return jsonb_build_object('workOrderId',w.id,'status','Cancelled','inventoryEffect',false,'idempotentReplay',true);end if;if w.status<>'Draft' then raise exception 'shadow_mode_can_cancel_draft_only';end if;
if exists(select 1 from public.mfg_component_allocations where work_order_id=w.id) or exists(select 1 from public.inventory_movements where reference_type='manufacturing' and reference_id=w.id::text) then raise exception 'draft_has_inventory_effects';end if;
update public.mfg_work_orders set status='Cancelled',cancelled_by=p_actor_user_id,cancelled_at=now(),cancellation_reason='Shadow Mode cleanup',cancellation_idempotency_key=p_idempotency_key,updated_at=now() where id=w.id;r:=jsonb_build_object('workOrderId',w.id,'status','Cancelled','inventoryEffect',false);return r;end $$;
revoke all on function public.cancel_mfg_shadow_draft(bigint,bigint,text) from public,anon,authenticated;grant execute on function public.cancel_mfg_shadow_draft(bigint,bigint,text) to service_role;
