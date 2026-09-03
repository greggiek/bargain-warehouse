-- Return the durable close result before checking the now-Closed lifecycle state.
begin;
create or replace function public.run_manufacturing_pilot_action(
 p_actor_user_id bigint,p_work_order_id bigint,p_action text,p_idempotency_key text
) returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare g public.manufacturing_pilot_gate%rowtype;l public.mfg_work_order_lines%rowtype;r jsonb;w public.mfg_work_orders%rowtype;h public.mfg_transfer_handoffs%rowtype;
begin
 g:=public.mfg_validate_pilot_work_order(p_work_order_id,p_actor_user_id);
 if nullif(btrim(coalesce(p_idempotency_key,'')),'') is null then raise exception 'idempotency_key_required';end if;
 select * into l from public.mfg_work_order_lines where work_order_id=p_work_order_id;
 if p_action='release' then
  if not public.mfg_pilot_flag_enabled('manufacturing_pilot_release_enabled') or not public.mfg_pilot_flag_enabled('manufacturing_pilot_inventory_enabled') then raise exception 'pilot_release_disabled';end if;
  r:=public.release_mfg_work_order(p_actor_user_id,p_work_order_id,p_idempotency_key,null);perform public.mfg_validate_pilot_work_order(p_work_order_id,p_actor_user_id);
 elsif p_action='start' then
  if not public.mfg_pilot_flag_enabled('manufacturing_pilot_release_enabled') then raise exception 'pilot_start_disabled';end if;
  r:=public.transition_mfg_work_order(p_actor_user_id,p_work_order_id,'start',p_idempotency_key);
 elsif p_action='record_good_unit' then
  if not public.mfg_pilot_flag_enabled('manufacturing_pilot_completion_enabled') or not public.mfg_pilot_flag_enabled('manufacturing_pilot_inventory_enabled') then raise exception 'pilot_completion_disabled';end if;
  r:=public.record_mfg_progress(p_actor_user_id,p_work_order_id,l.id,'good','unstarted',1,'[]'::jsonb,'BM-MFG-PILOT-001 one good unit',p_idempotency_key);
 elsif p_action='complete' then
  if not public.mfg_pilot_flag_enabled('manufacturing_pilot_completion_enabled') or not public.mfg_pilot_flag_enabled('manufacturing_pilot_transfer_enabled') then raise exception 'pilot_transfer_disabled';end if;
  r:=public.complete_mfg_work_order(p_actor_user_id,p_work_order_id,p_idempotency_key);
 elsif p_action='close' then
  if not public.mfg_pilot_flag_enabled('manufacturing_pilot_completion_enabled') then raise exception 'pilot_close_disabled';end if;
  select * into w from public.mfg_work_orders where id=p_work_order_id for update;
  select * into h from public.mfg_transfer_handoffs where work_order_id=p_work_order_id for update;
  select details into r from public.mfg_audit_events where work_order_id=w.id and idempotency_key=p_idempotency_key||':audit';
  if found then return r;end if;
  if w.status<>'Completed' or not exists(select 1 from public.shopify_transfer_links s where s.id=h.shopify_transfer_link_id
    and s.pilot_identifier=g.pilot_identifier and s.pilot_work_order_id=p_work_order_id and lower(s.status) in('received','completed'))
  then raise exception 'pilot_transfer_receipt_required';end if;
  update public.mfg_work_orders set status='Closed',closed_at=now(),closed_by=p_actor_user_id,updated_at=now() where id=w.id;
  insert into public.mfg_status_history(work_order_id,from_status,to_status,changed_by,idempotency_key) values(w.id,'Completed','Closed',p_actor_user_id,p_idempotency_key||':status');
  r:=jsonb_build_object('workOrderId',w.id,'status','Closed','inventoryEffect',false,'transferLinkId',h.shopify_transfer_link_id);
  insert into public.mfg_audit_events(work_order_id,event_type,actor_user_id,idempotency_key,details) values(w.id,'closed',p_actor_user_id,p_idempotency_key||':audit',r);
 else raise exception 'pilot_action_not_allowed';end if;
 return r;
end $$;
update public.manufacturing_pilot_gate set enabled=false where pilot_identifier='BM-MFG-PILOT-001';
update public.mfg_feature_flags set enabled=false,updated_at=now() where flag_key like 'manufacturing_pilot_%';
commit;
