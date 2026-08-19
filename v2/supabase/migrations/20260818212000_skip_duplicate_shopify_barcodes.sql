-- Preserve the first deterministic Shopify SKU for a duplicate barcode.
-- Other colliding records still mirror, but carry no barcode rather than failing the catalog sync.
-- One-way Shopify -> V2 catalog mirror. The function is service-role only;
-- it never contacts or mutates Shopify.
create or replace function public.sync_shopify_catalog_mirror(
  p_catalog jsonb,
  p_user_id bigint,
  p_user_name text,
  p_user_email text
)
returns table(created_count integer, refreshed_count integer, source_variant_count integer)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_created_count integer := 0;
  v_refreshed_count integer := 0;
  v_source_variant_count integer := 0;
begin
  if jsonb_typeof(p_catalog) <> 'array' then
    raise exception 'catalog payload must be an array';
  end if;

  with raw_catalog as (
    select
      upper(trim(item->>'sku')) as sku_key,
      trim(item->>'sku') as sku,
      coalesce(nullif(trim(item->>'name'), ''), trim(item->>'sku')) as name,
      nullif(trim(item->>'barcode'), '') as incoming_barcode,
      coalesce(item->'sources', '[]'::jsonb) as sources
    from jsonb_array_elements(p_catalog) as item
    where nullif(trim(item->>'sku'), '') is not null
  ),
  catalog as (
    select distinct on (sku_key)
      sku_key, sku, name, incoming_barcode, sources
    from raw_catalog
    order by sku_key, sku
  ),
  existing_base as (
    select catalog.*, products.id as existing_product_id, products.barcode as existing_barcode
    from catalog
    left join public.products
      on upper(trim(products.sku)) = catalog.sku_key
  ),
  existing as (
    select
      existing_base.*,
      row_number() over (partition by incoming_barcode order by sku_key) as incoming_barcode_rank
    from existing_base
  ),
  safe_catalog as (
    select
      existing.*,
      case
        when incoming_barcode is null then existing_barcode
        when incoming_barcode_rank > 1 then existing_barcode
        when exists (
          select 1
          from public.products other_product
          where other_product.barcode = incoming_barcode
            and upper(trim(other_product.sku)) <> existing.sku_key
        ) then existing_barcode
        else incoming_barcode
      end as barcode
    from existing
  ),
  upserted as (
    insert into public.products (sku, name, barcode, uom, active)
    select sku, name, barcode, 'EA', true
    from safe_catalog
    on conflict (upper(trim(sku))) do update
      set name = excluded.name,
          barcode = excluded.barcode,
          active = true,
          updated_at = now()
    returning id, upper(trim(sku)) as sku_key
  ),
  source_rows as (
    select
      upserted.id as product_id,
      source->>'storeKey' as store_key,
      source->>'productId' as shopify_product_id,
      source->>'variantId' as shopify_variant_id,
      nullif(source->>'inventoryItemId', '') as shopify_inventory_item_id
    from safe_catalog
    join upserted using (sku_key)
    cross join lateral jsonb_array_elements(safe_catalog.sources) as source
    where source->>'storeKey' in ('store_1', 'store_2')
      and nullif(source->>'productId', '') is not null
      and nullif(source->>'variantId', '') is not null
  ),
  synced_sources as (
    insert into public.product_shopify_sources (
      product_id, store_key, shopify_product_id, shopify_variant_id, shopify_inventory_item_id, last_synced_at
    )
    select product_id, store_key, shopify_product_id, shopify_variant_id, shopify_inventory_item_id, now()
    from source_rows
    on conflict (store_key, shopify_variant_id) do update
      set product_id = excluded.product_id,
          shopify_product_id = excluded.shopify_product_id,
          shopify_inventory_item_id = excluded.shopify_inventory_item_id,
          last_synced_at = excluded.last_synced_at
    returning id
  )
  select
    count(*) filter (where existing_product_id is null)::integer,
    count(*) filter (where existing_product_id is not null)::integer,
    (select count(*)::integer from synced_sources)
  into v_created_count, v_refreshed_count, v_source_variant_count
  from safe_catalog;

  insert into public.activity_events (
    user_id, user_name, user_email, action_type, document_type, description, status, metadata
  )
  values (
    p_user_id,
    p_user_name,
    p_user_email,
    'shopify_catalog_mirror_sync',
    'shopify_catalog',
    'Synced the Shopify catalog into the V2 read-only mirror',
    'success',
    jsonb_build_object(
      'source', 'shopify',
      'qoblex_connected', false,
      'created_count', v_created_count,
      'refreshed_count', v_refreshed_count,
      'source_variant_count', v_source_variant_count
    )
  );

  return query select v_created_count, v_refreshed_count, v_source_variant_count;
end;
$$;

revoke execute on function public.sync_shopify_catalog_mirror(jsonb, bigint, text, text) from public, anon, authenticated;
grant execute on function public.sync_shopify_catalog_mirror(jsonb, bigint, text, text) to service_role;
