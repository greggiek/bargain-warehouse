-- Preserve signed Shopify inventory in BM Warehouse.
-- The correction backup is intentionally permanent and service-role readable only.
create table if not exists public.inventory_signed_correction_runs(
  run_id uuid primary key default gen_random_uuid(), migration_name text not null, status text not null,
  intended_row_count integer not null default 0, backup_row_count integer not null default 0,
  restored_row_count integer not null default 0, negative_on_hand_count integer not null default 0,
  committed_gt_on_hand_count integer not null default 0, minimum_on_hand numeric, minimum_available numeric,
  backup_checksum text, movements_before bigint, movements_after bigint,
  outbound_shopify_writes integer not null default 0, created_at timestamptz not null default now(), completed_at timestamptz);
create table if not exists public.inventory_balance_signed_correction_backups(
  run_id uuid not null references public.inventory_signed_correction_runs(run_id) on delete restrict,
  product_id bigint not null, location_id bigint not null, quantity_before numeric not null,
  allocated_quantity_before numeric not null, balance_updated_at_before timestamptz, store_key text not null,
  shopify_location_id text not null, shopify_inventory_item_id text not null, sku text,
  cache_on_hand numeric not null, cache_available numeric not null, cache_committed numeric not null,
  cache_source_updated_at timestamptz, cache_last_synchronized_at timestamptz not null,
  completed_snapshot_job_id uuid not null, completed_snapshot_started_at timestamptz not null,
  completed_snapshot_completed_at timestamptz not null, backed_up_at timestamptz not null default now(),
  primary key(run_id,product_id,location_id));
revoke all on public.inventory_signed_correction_runs from public,anon,authenticated;
revoke all on public.inventory_balance_signed_correction_backups from public,anon,authenticated;
grant select on public.inventory_signed_correction_runs to service_role;
grant select on public.inventory_balance_signed_correction_backups to service_role;
alter table public.inventory_balances drop constraint if exists inventory_balances_allocation_check;
alter table public.inventory_balances add constraint inventory_balances_allocation_check check(allocated_quantity>=0);

-- Keep the legacy operational balance compatible with its nonnegative allocation constraints.
-- The lean Shopify cache retains exact source on_hand/available/committed values for Forecasting.
create or replace function public.apply_v2_shopify_inventory_sync_page(
  p_store_key text,
  p_cycle_key text,
  p_items jsonb
) returns jsonb
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_item jsonb;
  v_level jsonb;
  v_sku text;
  v_item_id text;
  v_product_id bigint;
  v_product_count integer;
  v_location_id bigint;
  v_on_hand numeric;
  v_available numeric;
  v_committed numeric;
  v_before numeric;
  v_before_allocated numeric;
  v_applied integer := 0;
  v_changed integer := 0;
  v_skipped integer := 0;
begin
  if p_store_key not in ('store_1','store_2') then raise exception 'Unknown Shopify store.'; end if;
  if nullif(btrim(coalesce(p_cycle_key,'')),'') is null then raise exception 'Sync cycle key is required.'; end if;
  if jsonb_typeof(coalesce(p_items,'[]'::jsonb)) <> 'array' then raise exception 'Inventory page must be an array.'; end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_sku := nullif(btrim(coalesce(v_item->>'sku','')),'');
    v_item_id := nullif(btrim(coalesce(v_item->>'inventoryItemId','')),'');
    if v_sku is null or v_item_id is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    select count(*), min(id) into v_product_count, v_product_id
    from public.products
    where active = true and upper(btrim(sku)) = upper(v_sku);
    if v_product_count <> 1 then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    for v_level in select value from jsonb_array_elements(coalesce(v_item->'levels','[]'::jsonb)) loop
      select location_id into v_location_id
      from public.shopify_location_mappings
      where store_key = p_store_key and shopify_location_id = coalesce(v_level->>'locationId','')
      limit 1;
      if v_location_id is null then continue; end if;

      v_on_hand := coalesce(nullif(v_level->>'onHand','')::numeric,0);
      v_available := coalesce(nullif(v_level->>'available','')::numeric,0);
      v_committed := coalesce(nullif(v_level->>'committed','')::numeric, v_on_hand - v_available);
      if v_committed < 0 then raise exception 'Shopify committed quantity cannot be negative for %.', v_sku; end if;

      insert into public.inventory_balances(product_id,location_id,quantity,allocated_quantity)
      values(v_product_id,v_location_id,0,0)
      on conflict(product_id,location_id) do nothing;

      select quantity,allocated_quantity into v_before,v_before_allocated
      from public.inventory_balances
      where product_id=v_product_id and location_id=v_location_id
      for update;

      update public.inventory_balances
      set quantity=v_on_hand, allocated_quantity=v_committed, updated_at=now()
      where product_id=v_product_id and location_id=v_location_id;

      v_applied := v_applied + 1;
      if v_before is distinct from v_on_hand then
        insert into public.inventory_movements(
          product_id,location_id,movement_type,quantity_delta,quantity_before,quantity_after,
          unit_cost,reference_type,reference_id,reason,idempotency_key,performed_by_name,metadata
        ) values (
          v_product_id,v_location_id,'shopify_reconciliation',v_on_hand-v_before,v_before,v_on_hand,
          null,'shopify_inventory_sync',v_item_id,'Shopify phased inventory reconciliation',
          'shopify-sync:'||p_store_key||':'||p_cycle_key||':'||v_item_id||':'||coalesce(v_level->>'locationId',''),
          'Shopify sync',
          jsonb_build_object('storeKey',p_store_key,'shopifyInventoryItemId',v_item_id,
            'shopifyLocationId',v_level->>'locationId','shopifyOnHand',v_level->>'onHand',
            'shopifyAvailable',v_available,'shopifyCommitted',v_level->>'committed',
            'operationalOnHand',v_on_hand,'operationalAllocated',v_committed)
        );
      end if;
      if v_before is distinct from v_on_hand or v_before_allocated is distinct from v_committed then
        v_changed := v_changed + 1;
      end if;
    end loop;
  end loop;
  return jsonb_build_object('appliedLevels',v_applied,'changedLevels',v_changed,'skippedItems',v_skipped);
end;
$$;

-- Production data restoration is executed transactionally by migration
-- backup_and_restore_signed_inventory_balances after validating completed snapshot coverage.
