-- Fast catalog lookup for V2 transfer creation. Kept service-role only; the API enforces warehouse access.
create or replace function public.search_v2_products(p_term text)
returns table(id bigint, sku text, name text, barcode text, category text)
language sql security invoker set search_path='pg_catalog','public' as $$
  select p.id,p.sku,p.name,p.barcode,p.category
  from public.products p
  where p.active
    and (p.sku ilike '%' || p_term || '%'
      or p.name ilike '%' || p_term || '%'
      or coalesce(p.barcode,'') ilike '%' || p_term || '%'
      or coalesce(p.category,'') ilike '%' || p_term || '%')
  order by
    case
      when upper(trim(p.sku))=upper(trim(p_term)) then 0
      when p.sku ilike p_term || '%' then 1
      when coalesce(p.barcode,'') ilike p_term || '%' then 2
      when p.name ilike p_term || '%' then 3
      else 4
    end,
    p.sku
  limit 12;
$$;
revoke execute on function public.search_v2_products(text) from public,anon,authenticated;
grant execute on function public.search_v2_products(text) to service_role;
