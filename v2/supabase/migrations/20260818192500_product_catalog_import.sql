create or replace function public.import_product_catalog(
  p_products jsonb,
  p_user_id bigint,
  p_user_name text,
  p_user_email text
)
returns table(inserted_count integer, updated_count integer)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_source_count integer;
  v_existing_count integer;
begin
  if jsonb_typeof(p_products) <> 'array' then
    raise exception 'p_products must be a JSON array';
  end if;

  with source as (
    select
      trim(item.sku) as sku,
      coalesce(nullif(trim(item.name), ''), trim(item.sku)) as name,
      nullif(trim(item.barcode), '') as barcode,
      coalesce(nullif(trim(item.uom), ''), 'EA') as uom,
      coalesce(item.active, true) as active,
      coalesce(item.purchase_price, 0) as purchase_price,
      coalesce(item.moving_average_cost, 0) as moving_average_cost
    from jsonb_to_recordset(p_products) as item(
      sku text,
      name text,
      barcode text,
      uom text,
      active boolean,
      purchase_price numeric,
      moving_average_cost numeric
    )
    where nullif(trim(item.sku), '') is not null
  )
  select
    count(*)::integer,
    count(p.id)::integer
  into v_source_count, v_existing_count
  from source s
  left join public.products p
    on upper(trim(p.sku)) = upper(s.sku);

  with source as (
    select
      trim(item.sku) as sku,
      coalesce(nullif(trim(item.name), ''), trim(item.sku)) as name,
      nullif(trim(item.barcode), '') as barcode,
      coalesce(nullif(trim(item.uom), ''), 'EA') as uom,
      coalesce(item.active, true) as active,
      coalesce(item.purchase_price, 0) as purchase_price,
      coalesce(item.moving_average_cost, 0) as moving_average_cost
    from jsonb_to_recordset(p_products) as item(
      sku text,
      name text,
      barcode text,
      uom text,
      active boolean,
      purchase_price numeric,
      moving_average_cost numeric
    )
    where nullif(trim(item.sku), '') is not null
  )
  insert into public.products(
    sku, name, barcode, uom, active, purchase_price, moving_average_cost
  )
  select
    sku, name, barcode, uom, active, purchase_price, moving_average_cost
  from source
  on conflict (upper(trim(sku))) do update
  set
    name = excluded.name,
    barcode = excluded.barcode,
    uom = excluded.uom,
    active = excluded.active,
    updated_at = now();

  insert into public.activity_events(
    user_id, user_name, user_email, action_type, document_type,
    description, status, metadata
  )
  values (
    p_user_id,
    p_user_name,
    p_user_email,
    'product_catalog_import',
    'product_catalog',
    format('Imported %s Shopify catalog products into BM Warehouse V2', v_source_count),
    'success',
    jsonb_build_object(
      'source', 'shopify',
      'inserted_count', v_source_count - v_existing_count,
      'updated_count', v_existing_count,
      'qoblex_connected', false
    )
  );

  return query
  select v_source_count - v_existing_count, v_existing_count;
end;
$$;

revoke all on function public.import_product_catalog(jsonb,bigint,text,text)
from public, anon, authenticated;
grant execute on function public.import_product_catalog(jsonb,bigint,text,text)
to service_role;
