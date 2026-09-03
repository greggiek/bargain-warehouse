begin;
do $$ begin
 if exists(select 1 from public.mfg_shopify_inventory_adjustments where location_id=6)
 then raise exception 'manufacturing_730_route_rollback_blocked_adjustments_exist';end if;
end $$;
delete from public.mfg_shopify_inventory_routes
where location_id=6 and store_key='store_2' and shopify_location_id='gid://shopify/Location/79725625401';
commit;
