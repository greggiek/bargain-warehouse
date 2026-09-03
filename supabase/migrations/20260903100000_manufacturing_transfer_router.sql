-- Route confirmed Manufacturing output through the established same-store or
-- cross-store Transfer workflow. Additive; all pilot controls remain disabled.
begin;

alter table public.intercompany_transfer_attempts add column pilot_identifier text references public.manufacturing_pilot_gate(pilot_identifier) on delete restrict;
alter table public.intercompany_transfer_attempts add column pilot_work_order_id bigint references public.mfg_work_orders(id) on delete restrict;
alter table public.intercompany_transfer_ledger_lines add column pilot_identifier text references public.manufacturing_pilot_gate(pilot_identifier) on delete restrict;
alter table public.intercompany_transfer_ledger_lines add column pilot_work_order_id bigint references public.mfg_work_orders(id) on delete restrict;
create index intercompany_attempts_pilot_idx on public.intercompany_transfer_attempts(pilot_identifier,pilot_work_order_id,status);
create index intercompany_ledger_pilot_idx on public.intercompany_transfer_ledger_lines(pilot_identifier,pilot_work_order_id,status);

create or replace function public.stamp_intercompany_pilot_ownership()
returns trigger language plpgsql security invoker set search_path='pg_catalog','public' as $$
begin
 if tg_op='UPDATE' and(old.pilot_identifier is distinct from new.pilot_identifier or old.pilot_work_order_id is distinct from new.pilot_work_order_id)
 then raise exception 'pilot_ownership_immutable';end if;
 if tg_op='INSERT' then
  select l.pilot_identifier,l.pilot_work_order_id into new.pilot_identifier,new.pilot_work_order_id
  from public.shopify_transfer_links l where l.id=new.transfer_link_id;
 end if;
 return new;
end $$;
create trigger stamp_intercompany_attempt_pilot before insert or update of pilot_identifier,pilot_work_order_id
 on public.intercompany_transfer_attempts for each row execute function public.stamp_intercompany_pilot_ownership();
create trigger stamp_intercompany_ledger_pilot before insert or update of pilot_identifier,pilot_work_order_id
 on public.intercompany_transfer_ledger_lines for each row execute function public.stamp_intercompany_pilot_ownership();

create or replace function public.refresh_mfg_transfer_handoff(p_handoff_id bigint)
returns text language plpgsql security definer set search_path='pg_catalog','public' as $$
declare h public.mfg_transfer_handoffs%rowtype;v_error text;
begin
 select * into h from public.mfg_transfer_handoffs where id=p_handoff_id for update;
 if not found then raise exception 'manufacturing_handoff_not_found';end if;
 if h.status in('created','cancelled','permanent_error','processing') then return h.status;end if;
 update public.mfg_transfer_handoffs x set
  source_store_key=src.store_key,source_shopify_location_id=src.shopify_location_id,
  destination_store_key=dst.store_key,destination_shopify_location_id=dst.shopify_location_id,updated_at=now()
 from public.shopify_location_mappings src,public.shopify_location_mappings dst
 where x.id=h.id and src.location_id=x.source_location_id and dst.location_id=x.destination_location_id;
 select * into h from public.mfg_transfer_handoffs where id=p_handoff_id;
 update public.mfg_transfer_handoff_lines l set
  source_shopify_variant_id=(select s.shopify_variant_id from public.product_shopify_sources s where s.product_id=l.product_id and s.store_key=h.source_store_key),
  source_shopify_inventory_item_id=(select s.shopify_inventory_item_id from public.product_shopify_sources s where s.product_id=l.product_id and s.store_key=h.source_store_key),
  destination_shopify_variant_id=(select s.shopify_variant_id from public.product_shopify_sources s where s.product_id=l.product_id and s.store_key=h.destination_store_key),
  destination_shopify_inventory_item_id=(select s.shopify_inventory_item_id from public.product_shopify_sources s where s.product_id=l.product_id and s.store_key=h.destination_store_key)
 where l.handoff_id=h.id;
 if h.source_store_key is null or h.destination_store_key is null
   or h.source_shopify_location_id is null or h.destination_shopify_location_id is null then
  v_error:='Transfer route mapping is incomplete.';
 elsif exists(select 1 from public.mfg_transfer_handoff_lines l where l.handoff_id=h.id and
   (l.source_shopify_variant_id is null or l.source_shopify_inventory_item_id is null
    or l.destination_shopify_variant_id is null or l.destination_shopify_inventory_item_id is null)) then
  select 'Missing Shopify mapping for SKU '||string_agg(sku,', ' order by sku) into v_error
  from public.mfg_transfer_handoff_lines where handoff_id=h.id and
   (source_shopify_variant_id is null or source_shopify_inventory_item_id is null
    or destination_shopify_variant_id is null or destination_shopify_inventory_item_id is null);
 end if;
 if v_error is not null then
  update public.mfg_transfer_handoffs set status='blocked_mapping',last_error=v_error,updated_at=now() where id=h.id;
  return 'blocked_mapping';
 end if;
 -- All completion adjustments must be genuinely confirmed; finished inventory
 -- additionally requires cache evidence at the source Shopify location.
 if exists(select 1 from public.mfg_shopify_inventory_adjustments a
    where a.work_order_id=h.work_order_id and a.status<>'confirmed')
 or exists(select 1 from public.mfg_transfer_handoff_lines l
   left join public.mfg_transfer_handoff_inventory_adjustments ha on ha.handoff_line_id=l.id
   left join public.mfg_shopify_inventory_adjustments a on a.id=ha.outbound_inventory_adjustment_id
   where l.handoff_id=h.id and(a.id is null or a.status<>'confirmed' or a.shopify_adjustment_id is null))
 or exists(select 1 from public.mfg_transfer_handoff_lines l where l.handoff_id=h.id and not exists(
   select 1 from public.mfg_transfer_handoff_inventory_adjustments ha
   join public.mfg_shopify_inventory_adjustments a on a.id=ha.outbound_inventory_adjustment_id
   join public.shopify_inventory_cache c on c.store_key=h.source_store_key
    and c.shopify_location_id=h.source_shopify_location_id
    and c.shopify_inventory_item_id=l.source_shopify_inventory_item_id
    and c.on_hand_quantity=a.expected_shopify_on_hand
   where ha.handoff_line_id=l.id)) then
  if h.status<>'pending_inventory_confirmation' then
   update public.mfg_transfer_handoffs set status='pending_inventory_confirmation',last_error=null,updated_at=now() where id=h.id;
  end if;
  return 'pending_inventory_confirmation';
 end if;
 update public.mfg_transfer_handoffs set status='ready',last_error=null,next_retry_at=null,updated_at=now() where id=h.id;
 return 'ready';
end $$;

create or replace function public.begin_mfg_transfer_handoff_link(p_handoff_id bigint,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='pg_catalog','public' as $$
declare h public.mfg_transfer_handoffs%rowtype;l public.shopify_transfer_links%rowtype;v_route text;v_ref text;g public.manufacturing_pilot_gate%rowtype;
begin
 select * into h from public.mfg_transfer_handoffs where id=p_handoff_id and status='processing'
  and lease_token=p_lease_token and lease_expires_at>now() for update;
 if not found then raise exception 'manufacturing_handoff_lease_lost';end if;
 if h.pilot_identifier is not null then perform public.mfg_validate_pilot_work_order(h.work_order_id,null);end if;
 v_route:=case when h.source_store_key=h.destination_store_key then 'same_store' else 'cross_store' end;
 v_ref:=case when v_route='same_store' then 'MFG-' else 'IC-MFG-' end||h.work_order_number;
 select * into l from public.shopify_transfer_links where manufacturing_handoff_id=h.id for update;
 if not found then
  if h.pilot_identifier is not null then select * into g from public.manufacturing_pilot_gate where pilot_identifier=h.pilot_identifier;end if;
  insert into public.shopify_transfer_links(bm_reference,route_type,status,source_location_id,destination_location_id,
   source_store_key,destination_store_key,source_shopify_location_id,destination_shopify_location_id,
   created_by_user_id,created_by_name,manufacturing_handoff_id,metadata)
  values(v_ref,v_route,'draft',h.source_location_id,h.destination_location_id,
   h.source_store_key,h.destination_store_key,h.source_shopify_location_id,h.destination_shopify_location_id,
   h.created_by,'Manufacturing transfer worker',h.id,jsonb_build_object(
    'created_from','manufacturing','work_order_id',h.work_order_id,'handoff_id',h.id,'route_type',v_route,
    'write_mode',case when v_route='same_store' then 'native_shopify_transfer' else 'intercompany_draft_only' end,
    'inventory_effect','none','pilot_identifier',h.pilot_identifier,'pilot_work_order_id',h.pilot_work_order_id,
    'bm_finished_sku',(select p.sku from public.mfg_transfer_handoff_lines x join public.products p on p.id=x.product_id where x.handoff_id=h.id limit 1),
    'shopify_source_sku',g.approved_shopify_source_sku,
    'source_entity',case when h.source_store_key='store_1' then 'Bargain Build Inc. (NY)' else 'Bargain Build CT Inc. (CT)' end,
    'destination_entity',case when h.destination_store_key='store_1' then 'Bargain Build Inc. (NY)' else 'Bargain Build CT Inc. (CT)' end))
  returning * into l;
  insert into public.shopify_transfer_link_lines(transfer_link_id,sku,product_id,quantity,source_shopify_variant_id,destination_shopify_variant_id)
   select l.id,x.sku,x.product_id,x.good_quantity,x.source_shopify_variant_id,x.destination_shopify_variant_id
   from public.mfg_transfer_handoff_lines x where x.handoff_id=h.id;
 end if;
 update public.mfg_transfer_handoffs set shopify_transfer_link_id=l.id,updated_at=now() where id=h.id;
 return jsonb_build_object('linkId',l.id,'bmReference',l.bm_reference,'routeType',l.route_type,
  'sourceStoreKey',h.source_store_key,'destinationStoreKey',h.destination_store_key,
  'existingShopifyTransferId',l.source_shopify_transfer_id,
  'lines',(select jsonb_agg(jsonb_build_object('sku',x.sku,'quantity',x.good_quantity,
   'inventoryItemId',x.source_shopify_inventory_item_id) order by x.id) from public.mfg_transfer_handoff_lines x where x.handoff_id=h.id));
end $$;

create or replace function public.finish_mfg_cross_store_transfer_draft(p_handoff_id bigint,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='pg_catalog','public' as $$
declare h public.mfg_transfer_handoffs%rowtype;l public.shopify_transfer_links%rowtype;r jsonb;
begin
 select * into h from public.mfg_transfer_handoffs where id=p_handoff_id and status='processing'
  and lease_token=p_lease_token and lease_expires_at>now() for update;
 if not found then raise exception 'manufacturing_handoff_lease_lost';end if;
 if h.pilot_identifier is not null then perform public.mfg_validate_pilot_work_order(h.work_order_id,null);end if;
 select * into l from public.shopify_transfer_links where id=h.shopify_transfer_link_id and manufacturing_handoff_id=h.id for update;
 if not found or l.route_type<>'cross_store' or l.status<>'draft' or l.source_shopify_transfer_id is not null
 then raise exception 'manufacturing_cross_store_draft_link_invalid';end if;
 update public.mfg_planned_transfers set status='promoted',shopify_transfer_link_id=l.id,updated_at=now() where work_order_id=h.work_order_id;
 update public.mfg_transfer_handoffs set status='created',completed_at=now(),lease_token=null,lease_expires_at=null,last_error=null,updated_at=now() where id=h.id;
 r:=jsonb_build_object('handoffId',h.id,'shopifyTransferLinkId',l.id,'bmReference',l.bm_reference,
  'routeType','cross_store','status','draft','inventoryEffect',false,'shipped',false,'received',false);
 insert into public.mfg_audit_events(work_order_id,event_type,actor_user_id,idempotency_key,details)
 values(h.work_order_id,'intercompany_transfer_draft_created',h.created_by,h.idempotency_key||':cross-store-draft-audit',r);
 return r;
end $$;

create or replace function public.assert_manufacturing_pilot_transfer_action(p_transfer_link_id uuid,p_actor_user_id bigint,p_action text)
returns void language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare l public.shopify_transfer_links%rowtype;g public.manufacturing_pilot_gate%rowtype;
begin
 select * into l from public.shopify_transfer_links where id=p_transfer_link_id for update;
 if not found then raise exception 'shopify_transfer_link_not_found';end if;
 if l.pilot_identifier is null and l.pilot_work_order_id is null then return;end if;
 if p_action in('edit_draft','delete_draft') then raise exception 'pilot_transfer_scope_immutable';end if;
 if p_action not in('mark_pending','return_to_draft','ship','receive') then raise exception 'pilot_transfer_action_not_allowed';end if;
 if not public.mfg_pilot_flag_enabled('manufacturing_pilot_transfer_enabled') then raise exception 'pilot_transfer_disabled';end if;
 g:=public.mfg_validate_pilot_work_order(l.pilot_work_order_id,p_actor_user_id);
 if l.pilot_identifier<>'BM-MFG-PILOT-001' or l.pilot_work_order_id is null
  or not exists(select 1 from public.mfg_transfer_handoffs h where h.id=l.manufacturing_handoff_id
    and h.work_order_id=l.pilot_work_order_id and h.pilot_identifier=l.pilot_identifier and h.pilot_work_order_id=l.pilot_work_order_id)
 then raise exception 'pilot_transfer_ownership_mismatch';end if;
 if l.source_location_id<>g.origin_location_id or l.destination_location_id<>g.destination_location_id
  or not exists(select 1 from public.shopify_location_mappings m where m.location_id=g.origin_location_id
    and m.store_key=l.source_store_key and m.shopify_location_id=l.source_shopify_location_id)
  or not exists(select 1 from public.shopify_location_mappings m where m.location_id=g.destination_location_id
    and m.store_key=l.destination_store_key and m.shopify_location_id=l.destination_shopify_location_id)
  or l.route_type<>'cross_store'
  or (select count(*) from public.shopify_transfer_link_lines x where x.transfer_link_id=l.id)<>1
  or not exists(select 1 from public.shopify_transfer_link_lines x where x.transfer_link_id=l.id
    and x.product_id=g.approved_finished_product_id and x.quantity=1)
 then raise exception 'pilot_transfer_scope_mismatch';end if;
end $$;

-- Cross-store receipt is the terminal evidence for the pilot work-order close.
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

revoke all on function public.finish_mfg_cross_store_transfer_draft(bigint,uuid) from public,anon,authenticated;
revoke all on function public.assert_manufacturing_pilot_transfer_action(uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.finish_mfg_cross_store_transfer_draft(bigint,uuid),public.assert_manufacturing_pilot_transfer_action(uuid,bigint,text) to service_role;

-- Deployment invariant: this migration never activates operational controls.
update public.manufacturing_pilot_gate set enabled=false where pilot_identifier='BM-MFG-PILOT-001';
update public.mfg_feature_flags set enabled=false,updated_at=now()
where flag_key in('manufacturing_release_enabled','manufacturing_completion_enabled','manufacturing_transfer_handoff_enabled',
 'manufacturing_shopify_outbound_enabled','manufacturing_inventory_mutations_enabled','manufacturing_pilot_release_enabled',
 'manufacturing_pilot_completion_enabled','manufacturing_pilot_inventory_enabled','manufacturing_pilot_outbound_enabled','manufacturing_pilot_transfer_enabled');

commit;
