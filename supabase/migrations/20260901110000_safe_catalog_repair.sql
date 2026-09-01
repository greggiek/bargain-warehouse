-- Additive, rollback-audited catalog repair support.
alter table public.product_shopify_sources
  add column if not exists shopify_sku text,
  add column if not exists normalized_sku text,
  add column if not exists source_barcode text,
  add column if not exists source_product_status text,
  add column if not exists mapping_method text,
  add column if not exists mapping_status text,
  add column if not exists last_verified_at timestamptz;

create unique index if not exists product_shopify_sources_store_inventory_item_unique
  on public.product_shopify_sources(store_key,shopify_inventory_item_id)
  where shopify_inventory_item_id is not null and shopify_inventory_item_id <> '';

create table if not exists public.shopify_catalog_repair_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null check(status in ('prepared','applied','validated','rolled_back','failed')),
  scope text not null,
  affected_skus text[] not null default '{}',
  products_before jsonb not null default '[]',
  mappings_before jsonb not null default '[]',
  created_product_ids bigint[] not null default '{}',
  created_mapping_ids bigint[] not null default '{}',
  report jsonb not null default '{}',
  rollback_notes text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  rolled_back_at timestamptz
);
alter table public.shopify_catalog_repair_runs enable row level security;
revoke all on public.shopify_catalog_repair_runs from anon,authenticated;
grant all on public.shopify_catalog_repair_runs to service_role;

create or replace function public.apply_safe_catalog_repair(p_catalog jsonb,p_affected_skus jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare
 v_run uuid:=gen_random_uuid(); v_item jsonb; v_source jsonb; v_sku text; v_name text;
 v_ids bigint[]; v_product_id bigint; v_created_products bigint[]:='{}'; v_created_mappings bigint[]:='{}';
 v_categories text[]; v_barcodes text[]; v_category text; v_barcode text;
 v_created int:=0; v_mappings int:=0; v_withheld int:=0; v_barcode_diffs int:=0; v_category_reviews int:=0;
 v_eligible text[]; v_source_count int; v_active_count int; v_mapping_id bigint;
begin
 if jsonb_typeof(p_catalog)<>'array' or jsonb_typeof(p_affected_skus)<>'array' then raise exception 'Catalog and affected SKUs must be arrays'; end if;
 select coalesce(array_agg(distinct upper(btrim(value #>> '{}'))),'{}') into v_eligible from jsonb_array_elements(p_affected_skus);
 insert into public.shopify_catalog_repair_runs(id,status,scope,affected_skus,products_before,mappings_before,rollback_notes)
 select v_run,'prepared','affected_ct_forecasting_catalog_repair',v_eligible,
  coalesce((select jsonb_agg(to_jsonb(p)) from public.products p where upper(btrim(p.sku))=any(v_eligible)),'[]'),
  coalesce((select jsonb_agg(to_jsonb(s)) from public.product_shopify_sources s join public.products p on p.id=s.product_id where upper(btrim(p.sku))=any(v_eligible)),'[]'),
  'Rollback: remove only created mapping IDs, then remove created product IDs only after confirming no operational references; restore preexisting snapshots if changed.';

 for v_item in select value from jsonb_array_elements(p_catalog) loop
  v_sku:=upper(btrim(v_item->>'normalizedSku'));
  if not(v_sku=any(v_eligible)) then continue; end if;
  if v_sku in ('BBA030','BCR012') or v_sku='' or v_sku is null then v_withheld:=v_withheld+1;continue;end if;
  v_name:=coalesce(nullif(btrim(v_item->>'name'),''),v_sku);
  if (v_name||' '||coalesce(v_item->>'category','')) ~* '\m(SERVICE|FEE|LABOR|DEPOSIT)\M' then v_withheld:=v_withheld+1;continue;end if;
  select count(*),count(*) filter(where upper(source->>'status')='ACTIVE'),
    array_agg(distinct nullif(btrim(source->>'category'),'')),
    array_agg(distinct nullif(btrim(source->>'barcode'),''))
  into v_source_count,v_active_count,v_categories,v_barcodes
  from jsonb_array_elements(coalesce(v_item->'sources','[]')) source
  where nullif(source->>'productId','') is not null and nullif(source->>'variantId','') is not null;
  if v_source_count=0 or v_active_count=0 then v_withheld:=v_withheld+1;continue;end if;

  select array_agg(id) into v_ids from public.products where upper(btrim(sku))=v_sku;
  if coalesce(array_length(v_ids,1),0)>1 then v_withheld:=v_withheld+1;continue;end if;
  v_category:=case when coalesce(array_length(v_categories,1),0)=1 then v_categories[1] else null end;
  if coalesce(array_length(v_categories,1),0)>1 then v_category_reviews:=v_category_reviews+1;end if;
  v_barcode:=case when v_source_count>1 and coalesce(array_length(v_barcodes,1),0)=1 and v_barcodes[1] is not null then v_barcodes[1] else null end;
  if coalesce(array_length(v_barcodes,1),0)>1 or (v_source_count>1 and coalesce(array_length(v_barcodes,1),0)<>1) then v_barcode_diffs:=v_barcode_diffs+1;end if;

  if coalesce(array_length(v_ids,1),0)=1 then
    v_product_id:=v_ids[1];
    update public.products set name=coalesce(nullif(name,''),v_name),updated_at=now() where id=v_product_id;
  else
    insert into public.products(sku,name,barcode,category,uom,active)
    values(v_sku,v_name,v_barcode,v_category,'EA',true) returning id into v_product_id;
    v_created_products:=array_append(v_created_products,v_product_id);v_created:=v_created+1;
  end if;

  for v_source in select value from jsonb_array_elements(v_item->'sources') loop
    if nullif(v_source->>'productId','') is null or nullif(v_source->>'variantId','') is null then continue;end if;
    insert into public.product_shopify_sources(product_id,store_key,shopify_product_id,shopify_variant_id,shopify_inventory_item_id,
      shopify_sku,normalized_sku,source_barcode,source_product_status,mapping_method,mapping_status,last_synced_at,last_verified_at)
    values(v_product_id,v_source->>'storeKey',v_source->>'productId',v_source->>'variantId',nullif(v_source->>'inventoryItemId',''),
      v_source->>'sku',v_sku,nullif(v_source->>'barcode',''),upper(v_source->>'status'),'normalized_sku','verified',now(),now())
    on conflict(store_key,shopify_variant_id) do update set
      product_id=excluded.product_id,shopify_product_id=excluded.shopify_product_id,
      shopify_inventory_item_id=excluded.shopify_inventory_item_id,shopify_sku=excluded.shopify_sku,
      normalized_sku=excluded.normalized_sku,source_barcode=excluded.source_barcode,
      source_product_status=excluded.source_product_status,mapping_method=excluded.mapping_method,
      mapping_status=excluded.mapping_status,last_synced_at=now(),last_verified_at=now()
    returning id into v_mapping_id;
    if not(v_mapping_id=any(v_created_mappings)) then v_created_mappings:=array_append(v_created_mappings,v_mapping_id);end if;
    v_mappings:=v_mappings+1;
  end loop;
 end loop;

 update public.shopify_catalog_repair_runs set status='applied',created_product_ids=v_created_products,
  created_mapping_ids=v_created_mappings,completed_at=now(),
  report=jsonb_build_object('canonicalProductsCreated',v_created,'sourceMappingsUpserted',v_mappings,
    'skusWithheld',v_withheld,'barcodeDifferencesPreserved',v_barcode_diffs,'categoriesRequiringReview',v_category_reviews)
 where id=v_run;
 return jsonb_build_object('runId',v_run,'canonicalProductsCreated',v_created,'sourceMappingsUpserted',v_mappings,
  'skusWithheld',v_withheld,'barcodeDifferencesPreserved',v_barcode_diffs,'categoriesRequiringReview',v_category_reviews);
exception when others then
 update public.shopify_catalog_repair_runs set status='failed',completed_at=now(),report=jsonb_build_object('error',sqlerrm) where id=v_run;
 raise;
end $$;

create or replace function public.reprocess_affected_ct_sales(p_skus jsonb)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_skus text[];v_lines int;v_units numeric;v_daily int;v_remaining_skus int;v_remaining_units numeric;
begin
 select coalesce(array_agg(distinct upper(btrim(value #>> '{}'))),'{}') into v_skus from jsonb_array_elements(p_skus);
 with resolved as (
  select d.store_key,d.shopify_order_id,d.shopify_line_id,p.id
  from public.shopify_sales_dedup d join public.products p on p.active and upper(btrim(p.sku))=upper(btrim(d.sku))
  where d.store_key='store_2' and d.product_id is null and upper(btrim(d.sku))=any(v_skus)
    and upper(btrim(d.sku)) not in ('BBA030','BCR012')
 )
 update public.shopify_sales_dedup d set product_id=r.id,last_synchronized_at=now()
 from resolved r where d.store_key=r.store_key and d.shopify_order_id=r.shopify_order_id and d.shopify_line_id=r.shopify_line_id;
 get diagnostics v_lines=row_count;
 select coalesce(sum(gross_fulfilled_quantity),0) into v_units from public.shopify_sales_dedup
 where store_key='store_2' and product_id is not null and upper(btrim(sku))=any(v_skus);

 insert into public.shopify_sales_daily(sales_date,product_id,store_key,sku,quantity_sold,gross_fulfilled_quantity,order_count,gross_sales,source_updated_at,last_synced_at)
 select sales_date,product_id,store_key,max(sku),sum(gross_fulfilled_quantity),sum(gross_fulfilled_quantity),
  count(distinct shopify_order_id),0,max(shopify_updated_at),now()
 from public.shopify_sales_dedup
 where store_key='store_2' and product_id is not null and upper(btrim(sku))=any(v_skus)
 group by sales_date,product_id,store_key
 on conflict(sales_date,product_id,store_key) do update set sku=excluded.sku,
  gross_fulfilled_quantity=excluded.gross_fulfilled_quantity,order_count=excluded.order_count,
  source_updated_at=excluded.source_updated_at,last_synced_at=now();
 get diagnostics v_daily=row_count;
 select count(distinct upper(btrim(sku))),coalesce(sum(gross_fulfilled_quantity),0)
 into v_remaining_skus,v_remaining_units from public.shopify_sales_dedup
 where store_key='store_2' and product_id is null and upper(btrim(sku)) not in ('BBA030','BCR012');
 return jsonb_build_object('linesRecovered',v_lines,'unitsRecovered',v_units,'dailyAggregatesRebuilt',v_daily,
  'remainingUnresolvedSkus',v_remaining_skus,'remainingUnresolvedUnits',v_remaining_units);
end $$;
revoke all on function public.apply_safe_catalog_repair(jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.reprocess_affected_ct_sales(jsonb) from public,anon,authenticated;
grant execute on function public.apply_safe_catalog_repair(jsonb,jsonb) to service_role;
grant execute on function public.reprocess_affected_ct_sales(jsonb) to service_role;
