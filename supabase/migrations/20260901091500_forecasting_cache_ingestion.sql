-- Transactional page ingestion and store/day finalization for the lean forecasting cache.

create or replace function public.upsert_shopify_sales_dedup_page(
  p_store_key text,
  p_rows jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_row jsonb;
  v_product_id bigint;
  v_existing boolean;
  v_inserted integer := 0;
  v_updated integer := 0;
  v_duplicates integer := 0;
  v_unmapped integer := 0;
begin
  if p_store_key not in ('store_1','store_2') then
    raise exception 'Unknown Shopify store';
  end if;
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'Sales rows must be a JSON array';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    select id into v_product_id
      from public.products
     where active = true
       and upper(btrim(sku)) = upper(btrim(v_row->>'sku'))
     limit 1;

    if v_product_id is null then
      v_unmapped := v_unmapped + 1;
    end if;

    select exists (
      select 1
        from public.shopify_sales_dedup
       where store_key = p_store_key
         and shopify_order_id = v_row->>'shopifyOrderId'
         and shopify_line_id = v_row->>'shopifyLineId'
    ) into v_existing;

    insert into public.shopify_sales_dedup(
      store_key, shopify_order_id, shopify_line_id, sales_date,
      product_id, sku, gross_fulfilled_quantity, shopify_updated_at,
      last_synchronized_at
    ) values (
      p_store_key,
      v_row->>'shopifyOrderId',
      v_row->>'shopifyLineId',
      (v_row->>'salesDate')::date,
      v_product_id,
      upper(btrim(v_row->>'sku')),
      (v_row->>'grossFulfilledQuantity')::numeric,
      (v_row->>'shopifyUpdatedAt')::timestamptz,
      now()
    )
    on conflict (store_key, shopify_order_id, shopify_line_id)
    do update set
      sales_date = excluded.sales_date,
      product_id = excluded.product_id,
      sku = excluded.sku,
      gross_fulfilled_quantity = excluded.gross_fulfilled_quantity,
      shopify_updated_at = excluded.shopify_updated_at,
      last_synchronized_at = now();

    if v_existing then
      v_updated := v_updated + 1;
      v_duplicates := v_duplicates + 1;
    else
      v_inserted := v_inserted + 1;
    end if;
    v_product_id := null;
  end loop;

  return jsonb_build_object(
    'inserted', v_inserted,
    'updated', v_updated,
    'duplicatesPrevented', v_duplicates,
    'unmappedSkus', v_unmapped
  );
end;
$$;

create or replace function public.finalize_shopify_sales_sync_job(
  p_job_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_job public.shopify_sync_jobs%rowtype;
  v_aggregate_rows integer := 0;
  v_coverage_rows integer := 0;
  v_gross numeric := 0;
begin
  select * into v_job
    from public.shopify_sync_jobs
   where id = p_job_id
   for update;

  if v_job.id is null then
    raise exception 'Shopify sync job not found';
  end if;
  if v_job.status <> 'running' then
    raise exception 'Shopify sync job is not running';
  end if;
  if v_job.window_start is null or v_job.window_end is null or v_job.window_start >= v_job.window_end then
    raise exception 'Shopify sync job has an invalid window';
  end if;

  -- Clear only the new verified cache columns. Legacy quantity_sold and gross_sales remain untouched.
  update public.shopify_sales_daily
     set gross_fulfilled_quantity = null,
         source_updated_at = null
   where store_key = v_job.store_key
     and sales_date >= v_job.window_start
     and sales_date < v_job.window_end;

  insert into public.shopify_sales_daily(
    sales_date, product_id, store_key, sku, quantity_sold,
    gross_fulfilled_quantity, order_count, gross_sales,
    source_updated_at, last_synced_at
  )
  select
    d.sales_date,
    d.product_id,
    d.store_key,
    max(d.sku),
    sum(d.gross_fulfilled_quantity),
    sum(d.gross_fulfilled_quantity),
    count(distinct d.shopify_order_id),
    0,
    max(d.shopify_updated_at),
    now()
  from public.shopify_sales_dedup d
  where d.store_key = v_job.store_key
    and d.sales_date >= v_job.window_start
    and d.sales_date < v_job.window_end
    and d.product_id is not null
  group by d.sales_date, d.product_id, d.store_key
  on conflict (sales_date, product_id, store_key)
  do update set
    sku = excluded.sku,
    gross_fulfilled_quantity = excluded.gross_fulfilled_quantity,
    order_count = excluded.order_count,
    source_updated_at = excluded.source_updated_at,
    last_synced_at = now();
  get diagnostics v_aggregate_rows = row_count;

  insert into public.shopify_sales_coverage(
    store_key, sales_date, status, gross_fulfilled_quantity,
    order_count, fulfillment_line_count, completed_at,
    last_error, last_synchronized_at
  )
  select
    v_job.store_key,
    day::date,
    case when coalesce(sum(d.gross_fulfilled_quantity),0) > 0
      then 'completed_with_sales'
      else 'completed_zero_sales'
    end,
    coalesce(sum(d.gross_fulfilled_quantity),0),
    count(distinct d.shopify_order_id),
    count(d.shopify_line_id),
    now(),
    null,
    now()
  from generate_series(v_job.window_start, v_job.window_end - 1, interval '1 day') day
  left join public.shopify_sales_dedup d
    on d.store_key = v_job.store_key
   and d.sales_date = day::date
  group by day
  on conflict (store_key, sales_date)
  do update set
    status = excluded.status,
    gross_fulfilled_quantity = excluded.gross_fulfilled_quantity,
    order_count = excluded.order_count,
    fulfillment_line_count = excluded.fulfillment_line_count,
    completed_at = excluded.completed_at,
    last_error = null,
    last_synchronized_at = now();
  get diagnostics v_coverage_rows = row_count;

  select coalesce(sum(gross_fulfilled_quantity),0)
    into v_gross
    from public.shopify_sales_coverage
   where store_key = v_job.store_key
     and sales_date >= v_job.window_start
     and sales_date < v_job.window_end
     and status in ('completed_with_sales','completed_zero_sales');

  update public.shopify_sync_jobs
     set status = 'completed',
         cursor = null,
         completed_at = now(),
         updated_at = now(),
         last_error = null,
         checkpoint = checkpoint || jsonb_build_object(
           'aggregateRows', v_aggregate_rows,
           'coverageRows', v_coverage_rows,
           'grossFulfilledUnits', v_gross
         )
   where id = p_job_id;

  return jsonb_build_object(
    'storeKey', v_job.store_key,
    'aggregateRows', v_aggregate_rows,
    'coverageRows', v_coverage_rows,
    'grossFulfilledUnits', v_gross
  );
end;
$$;

revoke all on function public.upsert_shopify_sales_dedup_page(text,jsonb) from public, anon, authenticated;
revoke all on function public.finalize_shopify_sales_sync_job(uuid) from public, anon, authenticated;
grant execute on function public.upsert_shopify_sales_dedup_page(text,jsonb) to service_role;
grant execute on function public.finalize_shopify_sales_sync_job(uuid) to service_role;
