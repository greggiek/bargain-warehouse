-- Warehouse manager inventory adjustments: V2 ledger only.
-- Damaged and missing stock reduce the location's on-hand balance and are recorded
-- as immutable inventory movements and activity events. Shopify and Qoblex are not changed.

create or replace function public.adjust_v2_inventory(
  p_product_id bigint,
  p_location_id bigint,
  p_quantity numeric,
  p_reason text,
  p_note text,
  p_idempotency_key text,
  p_user_id bigint,
  p_user_name text
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_before numeric;
  v_after numeric;
  v_allocated numeric;
  v_product public.products%rowtype;
  v_reason text := lower(trim(coalesce(p_reason, '')));
  v_movement_type text;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if p_product_id is null or p_location_id is null then
    raise exception 'product and warehouse are required';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'quantity must be greater than zero';
  end if;
  if v_reason not in ('damage', 'missing_stock') then
    raise exception 'reason must be damage or missing_stock';
  end if;
  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null then
    raise exception 'idempotency key is required';
  end if;

  select * into v_product from public.products where id = p_product_id and active = true;
  if not found then raise exception 'active product not found'; end if;

  insert into public.inventory_balances(product_id, location_id, quantity, allocated_quantity)
  values (p_product_id, p_location_id, 0, 0)
  on conflict(product_id, location_id) do nothing;

  select quantity, allocated_quantity into v_before, v_allocated
  from public.inventory_balances
  where product_id = p_product_id and location_id = p_location_id
  for update;

  v_after := v_before - p_quantity;
  -- Negative on-hand is allowed so the ledger accurately exposes an actual shortage.
  -- Do not permit an adjustment to silently consume inventory that is already allocated.
  if v_after < v_allocated then
    raise exception 'cannot adjust below the % pieces already allocated', v_allocated;
  end if;

  update public.inventory_balances
  set quantity = v_after, updated_at = now()
  where product_id = p_product_id and location_id = p_location_id;

  v_movement_type := case when v_reason = 'damage' then 'damage' else 'adjustment' end;
  insert into public.inventory_movements(
    product_id, location_id, movement_type, quantity_delta, quantity_before, quantity_after,
    unit_cost, reference_type, reference_id, reason, idempotency_key,
    performed_by_user_id, performed_by_name, metadata
  ) values (
    p_product_id, p_location_id, v_movement_type, -p_quantity, v_before, v_after,
    v_product.moving_average_cost, 'inventory_adjustment', null,
    case when v_reason = 'damage' then 'Damaged stock' else 'Missing stock' end,
    p_idempotency_key, p_user_id, p_user_name,
    jsonb_build_object('adjustmentReason', v_reason, 'note', v_note)
  );

  insert into public.activity_events(
    user_id, user_name, action_type, document_type, document_number, description, status, metadata
  ) values (
    p_user_id, coalesce(nullif(trim(p_user_name), ''), 'Warehouse user'),
    'INVENTORY_ADJUSTED', 'inventory_adjustment', 'ADJ-' || p_idempotency_key,
    case when v_reason = 'damage' then 'Recorded damaged stock: ' else 'Recorded missing stock: ' end
      || p_quantity || ' of ' || v_product.sku,
    'success',
    jsonb_build_object('productId', p_product_id, 'locationId', p_location_id, 'quantity', p_quantity, 'reason', v_reason, 'note', v_note)
  );

  return jsonb_build_object(
    'productId', p_product_id, 'sku', v_product.sku, 'quantity', p_quantity,
    'quantityBefore', v_before, 'quantityAfter', v_after, 'reason', v_reason
  );
end;
$$;

revoke all on function public.adjust_v2_inventory(bigint, bigint, numeric, text, text, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.adjust_v2_inventory(bigint, bigint, numeric, text, text, text, bigint, text)
  to service_role;
