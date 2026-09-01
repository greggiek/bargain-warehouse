-- Add current Shopify catalog evidence to the disposable inventory snapshot.
alter table public.shopify_inventory_cache
  add column if not exists shopify_product_id text,
  add column if not exists source_product_title text,
  add column if not exists source_product_type text,
  add column if not exists source_product_status text,
  add column if not exists source_tracks_inventory boolean;

CREATE OR REPLACE FUNCTION public.upsert_shopify_inventory_cache_page(p_store_key text, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_item jsonb; v_level jsonb; v_product_id bigint; v_candidate_count integer;
  v_location_exists boolean; v_sku text; v_applied integer := 0;
  v_unmapped_skus integer := 0; v_ambiguous_skus integer := 0;
  v_unmapped_locations integer := 0; v_mapped_by_source integer := 0; v_mapped_by_sku integer := 0;
begin
  if p_store_key not in ('store_1','store_2') then raise exception 'Unknown Shopify store'; end if;
  if jsonb_typeof(coalesce(p_items,'[]'::jsonb)) <> 'array' then raise exception 'Inventory items must be a JSON array'; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    v_product_id := null;
    v_sku := upper(btrim(coalesce(v_item->>'normalizedSku', v_item->>'sku',''), E' \t\n\r\u00a0'));
    if v_sku = '' or coalesce(v_item->>'inventoryItemId','') = '' then v_unmapped_skus := v_unmapped_skus + 1; continue; end if;
    select min(s.product_id), count(distinct s.product_id) into v_product_id, v_candidate_count
      from public.product_shopify_sources s where s.store_key=p_store_key and s.mapping_status='verified'
       and (s.shopify_inventory_item_id=v_item->>'inventoryItemId'
         or (coalesce(v_item->>'variantId','')<>'' and s.shopify_variant_id=v_item->>'variantId'));
    if v_candidate_count=1 then v_mapped_by_source:=v_mapped_by_source+1;
    elsif v_candidate_count>1 then v_product_id:=null; v_ambiguous_skus:=v_ambiguous_skus+1;
    else
      select min(p.id),count(*) into v_product_id,v_candidate_count from public.products p
       where upper(btrim(coalesce(p.sku,''), E' \t\n\r\u00a0'))=v_sku;
      if v_candidate_count=1 then v_mapped_by_sku:=v_mapped_by_sku+1;
      elsif v_candidate_count>1 then v_product_id:=null; v_ambiguous_skus:=v_ambiguous_skus+1;
      else v_product_id:=null; v_unmapped_skus:=v_unmapped_skus+1; end if;
    end if;
    if v_product_id is not null then
      update public.product_shopify_sources set
        source_product_type=coalesce(nullif(v_item->>'productType',''),source_product_type),
        source_product_status=coalesce(nullif(lower(v_item->>'productStatus'),''),source_product_status),
        source_tracks_inventory=case when v_item?'tracksInventory' then (v_item->>'tracksInventory')::boolean else source_tracks_inventory end,
        last_verified_at=now()
      where store_key=p_store_key and product_id=v_product_id
        and (shopify_inventory_item_id=v_item->>'inventoryItemId' or shopify_variant_id=nullif(v_item->>'variantId',''));
    end if;
    for v_level in select value from jsonb_array_elements(coalesce(v_item->'levels','[]'::jsonb)) loop
      select exists(select 1 from public.shopify_location_mappings where store_key=p_store_key and shopify_location_id=v_level->>'locationId') into v_location_exists;
      if not v_location_exists then v_unmapped_locations:=v_unmapped_locations+1; continue; end if;
      insert into public.shopify_inventory_cache(
        store_key,shopify_location_id,shopify_inventory_item_id,shopify_variant_id,product_id,sku,
        on_hand_quantity,available_quantity,committed_quantity,source_updated_at,last_synchronized_at,
        shopify_product_id,source_product_title,source_product_type,source_product_status,source_tracks_inventory)
      values(p_store_key,v_level->>'locationId',v_item->>'inventoryItemId',nullif(v_item->>'variantId',''),v_product_id,v_sku,
        coalesce((v_level->>'onHand')::numeric,0),coalesce((v_level->>'available')::numeric,0),coalesce((v_level->>'committed')::numeric,0),
        nullif(v_item->>'sourceUpdatedAt','')::timestamptz,now(),nullif(v_item->>'productId',''),nullif(v_item->>'productTitle',''),
        nullif(v_item->>'productType',''),nullif(lower(v_item->>'productStatus'),''),
        case when v_item?'tracksInventory' then (v_item->>'tracksInventory')::boolean else null end)
      on conflict(store_key,shopify_location_id,shopify_inventory_item_id) do update set
        shopify_variant_id=excluded.shopify_variant_id,product_id=excluded.product_id,sku=excluded.sku,
        on_hand_quantity=excluded.on_hand_quantity,available_quantity=excluded.available_quantity,
        committed_quantity=excluded.committed_quantity,source_updated_at=excluded.source_updated_at,last_synchronized_at=now(),
        shopify_product_id=coalesce(excluded.shopify_product_id,shopify_inventory_cache.shopify_product_id),
        source_product_title=coalesce(excluded.source_product_title,shopify_inventory_cache.source_product_title),
        source_product_type=coalesce(excluded.source_product_type,shopify_inventory_cache.source_product_type),
        source_product_status=coalesce(excluded.source_product_status,shopify_inventory_cache.source_product_status),
        source_tracks_inventory=coalesce(excluded.source_tracks_inventory,shopify_inventory_cache.source_tracks_inventory);
      v_applied:=v_applied+1;
    end loop;
  end loop;
  return jsonb_build_object('appliedLevels',v_applied,'unmappedSkus',v_unmapped_skus,'ambiguousSkus',v_ambiguous_skus,
    'unmappedLocations',v_unmapped_locations,'mappedBySource',v_mapped_by_source,'mappedBySku',v_mapped_by_sku);
end;$function$
;
