-- Return the cost references used to guide new purchase order pricing.
drop function if exists public.search_v2_products(text);

create function public.search_v2_products(p_term text)
returns table(
  id bigint, sku text, name text, barcode text, category text,
  purchase_price numeric, moving_average_cost numeric
)
language sql security invoker set search_path='pg_catalog','public' as $$
  select p.id,p.sku,p.name,p.barcode,p.category,p.purchase_price,p.moving_average_cost
  from public.products p
  where p.active
    and (p.sku ilike '%' || p_term || '%'
      or p.name ilike '%' || p_term || '%'
      or coalesce(p.barcode,'') ilike '%' || p_term || '%'
      or coalesce(p.category,'') ilike '%' || p_term || '%')
  order by case
    when upper(trim(p.sku)) = upper(trim(p_term)) then 0
    when p.sku ilike p_term || '%' then 1
    when coalesce(p.barcode,'') ilike p_term || '%' then 2
    when p.name ilike p_term || '%' then 3
    else 4 end,p.sku
  limit 12;
$$;

revoke all on function public.search_v2_products(text) from public, anon, authenticated;
grant execute on function public.search_v2_products(text) to service_role;