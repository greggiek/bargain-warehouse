-- Capture the validated gate row before checking immutable transfer scope.
begin;
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
revoke all on function public.assert_manufacturing_pilot_transfer_action(uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.assert_manufacturing_pilot_transfer_action(uuid,bigint,text) to service_role;
update public.manufacturing_pilot_gate set enabled=false where pilot_identifier='BM-MFG-PILOT-001';
update public.mfg_feature_flags set enabled=false,updated_at=now() where flag_key like 'manufacturing_pilot_%';
commit;
