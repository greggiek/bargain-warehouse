-- Required outbound identity route for Manufacturing movements at 730 Windham.
begin;
insert into public.mfg_shopify_inventory_routes(location_id,store_key,shopify_location_id,active)
select l.id,m.store_key,m.shopify_location_id,true
from public.locations l
join public.shopify_location_mappings m on m.location_id=l.id
where l.id=6 and l.code='730' and l.name='730 Windham Rd'
  and m.store_key='store_2' and m.shopify_location_id='gid://shopify/Location/79725625401'
on conflict(location_id) do update set
 store_key=excluded.store_key,shopify_location_id=excluded.shopify_location_id,active=true,configured_at=now();
do $$ begin
 if not exists(select 1 from public.mfg_shopify_inventory_routes where location_id=6 and store_key='store_2'
   and shopify_location_id='gid://shopify/Location/79725625401' and active)
 then raise exception 'manufacturing_730_shopify_route_not_resolved';end if;
end $$;
commit;
