-- Current Shopify inventory snapshot ingestion. No inventory history is retained.

create or replace function public.upsert_shopify_inventory_cache_page(
  p_store_key text,
  p_items jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_item jsonb;
  v_level jsonb;
  v_product_id bigint;
  v_location_exists boolean;
  v_sku text;
  v_applied integer := 0;
  v_unmapped_skus integer := 0;
  v_unmapped_locations integer := 0;
begin
  if p_store_key not in ('store_1','store_2') then
    raise exception 'Unknown Shopify store';
  end if;
  if jsonb_typeof(coalesce(p_items,'[]'::jsonb)) <> 'array' then
    raise exception 'Inventory items must be a JSON array';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_sku := upper(btrim(coalesce(v_item->>'sku','')));
    if v_sku = '' or coalesce(v_item->>'inventoryItemId','') = '' then
      v_unmapped_skus := v_unmapped_skus + 1;
      continue;
    end if;

    select id into v_product_id
      from public.products
     where active = true and upper(btrim(sku)) = v_sku
     limit 1;
    if v_product_id is null then
      v_unmapped_skus := v_unmapped_skus + 1;
    end if;

    for v_level in select value from jsonb_array_elements(coalesce(v_item->'levels','[]'::jsonb)) loop
      select exists (
        select 1 from public.shopify_location_mappings
         where store_key = p_store_key
           and shopify_location_id = v_level->>'locationId'
      ) into v_location_exists;

      if not v_location_exists then
        v_unmapped_locations := v_unmapped_locations + 1;
        continue;
      end if;

      insert into public.shopify_inventory_cache(
        store_key, shopify_location_id, shopify_inventory_item_id,
        shopify_variant_id, product_id, sku, on_hand_quantity,
        available_quantity, committed_quantity, source_updated_at,
        last_synchronized_at
      ) values (
        p_store_key,
        v_level->>'locationId',
        v_item->>'inventoryItemId',
        nullif(v_item->>'variantId',''),
        v_product_id,
        v_sku,
        coalesce((v_level->>'onHand')::numeric,0),
        coalesce((v_level->>'available')::numeric,0),
        coalesce((v_level->>'committed')::numeric,0),
        nullif(v_item->>'sourceUpdatedAt','')::timestamptz,
        now()
      )
      on conflict (store_key, shopify_location_id, shopify_inventory_item_id)
      do update set
        shopify_variant_id = excluded.shopify_variant_id,
        product_id = excluded.product_id,
        sku = excluded.sku,
        on_hand_quantity = excluded.on_hand_quantity,
        available_quantity = excluded.available_quantity,
        committed_quantity = excluded.committed_quantity,
        source_updated_at = excluded.source_updated_at,
        last_synchronized_at = now();
      v_applied := v_applied + 1;
    end loop;
    v_product_id := null;
  end loop;

  return jsonb_build_object(
    'appliedLevels', v_applied,
    'unmappedSkus', v_unmapped_skus,
    'unmappedLocations', v_unmapped_locations
  );
end;
$$;

revoke all on function public.upsert_shopify_inventory_cache_page(text,jsonb) from public, anon, authenticated;
grant execute on function public.upsert_shopify_inventory_cache_page(text,jsonb) to service_role;
