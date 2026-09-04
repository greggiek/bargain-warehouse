begin;

-- Close Manufacturing work orders only after the routed transfer is actually received.
-- Same-store handoffs carry a Shopify-native transfer id; cross-store handoffs
-- intentionally carry only the immutable BM transfer link and two applied legs.
create or replace function public.close_mfg_work_order(
  p_actor_user_id bigint,
  p_work_order_id bigint,
  p_idempotency_key text
) returns jsonb
language plpgsql
security invoker
set search_path = 'pg_catalog', 'public'
as $$
declare
  w public.mfg_work_orders%rowtype;
  h public.mfg_transfer_handoffs%rowtype;
  sl public.shopify_transfer_links%rowtype;
  r jsonb;
begin
  if not public.mfg_actor_can(p_actor_user_id,'manufacturing_close') then
    raise exception 'manufacturing_permission_denied:manufacturing_close';
  end if;

  select * into w from public.mfg_work_orders where id=p_work_order_id for update;
  if not found then raise exception 'work_order_not_found'; end if;

  if not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=w.production_location_id and can_manage)
     or not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=w.destination_location_id and can_manage)
  then raise exception 'manufacturing_location_permission_denied'; end if;

  select details into r from public.mfg_audit_events
   where work_order_id=w.id and idempotency_key=p_idempotency_key||':audit';
  if found then return r; end if;

  if w.status<>'Completed' then raise exception 'only_completed_work_order_can_close'; end if;

  select * into h from public.mfg_transfer_handoffs where work_order_id=w.id for update;
  if not found or h.status<>'created' or h.shopify_transfer_link_id is null then
    raise exception 'work_order_transfer_handoff_unresolved';
  end if;

  select * into sl from public.shopify_transfer_links
   where id=h.shopify_transfer_link_id and manufacturing_handoff_id=h.id
   for update;
  if not found or sl.status<>'received' or sl.pilot_work_order_id is distinct from w.id then
    raise exception 'work_order_transfer_handoff_unresolved';
  end if;

  if sl.route_type='same_store' then
    if h.shopify_transfer_id is null or sl.source_shopify_transfer_id is distinct from h.shopify_transfer_id then
      raise exception 'work_order_transfer_handoff_unresolved';
    end if;
  elsif sl.route_type='cross_store' then
    if h.shopify_transfer_id is not null or sl.source_shopify_transfer_id is not null
       or (select count(*) from public.intercompany_transfer_attempts a
            where a.transfer_link_id=sl.id and a.leg='ship' and a.status='applied')<>1
       or (select count(*) from public.intercompany_transfer_attempts a
            where a.transfer_link_id=sl.id and a.leg='receive' and a.status='applied')<>1
    then raise exception 'work_order_transfer_handoff_unresolved'; end if;
  else
    raise exception 'work_order_transfer_handoff_unresolved';
  end if;

  if exists(select 1 from public.mfg_transfer_handoff_lines x
    left join public.shopify_transfer_link_lines line
      on line.transfer_link_id=h.shopify_transfer_link_id
     and line.product_id=x.product_id and line.quantity=x.good_quantity
    where x.handoff_id=h.id and line.id is null)
  or exists(select 1 from public.mfg_transfer_handoff_lines x
    join public.mfg_transfer_handoff_inventory_adjustments ha on ha.handoff_line_id=x.id
    join public.mfg_shopify_inventory_adjustments a on a.id=ha.outbound_inventory_adjustment_id
    where x.handoff_id=h.id and a.status<>'confirmed')
  then raise exception 'work_order_transfer_handoff_unresolved'; end if;

  update public.mfg_work_orders
     set status='Closed',closed_at=now(),closed_by=p_actor_user_id,updated_at=now()
   where id=w.id;
  insert into public.mfg_status_history(work_order_id,from_status,to_status,changed_by,idempotency_key)
  values(w.id,'Completed','Closed',p_actor_user_id,p_idempotency_key||':status');

  r:=jsonb_build_object('workOrderId',w.id,'status','Closed','inventoryEffect',false,
    'routeType',sl.route_type,'transferLinkId',sl.id,'shopifyTransferId',h.shopify_transfer_id);
  insert into public.mfg_audit_events(work_order_id,event_type,actor_user_id,idempotency_key,details)
  values(w.id,'closed',p_actor_user_id,p_idempotency_key||':audit',r);
  return r;
end $$;

revoke all on function public.close_mfg_work_order(bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.close_mfg_work_order(bigint,bigint,text) to service_role;

commit;
