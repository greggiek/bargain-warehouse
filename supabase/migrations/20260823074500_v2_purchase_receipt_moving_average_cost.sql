-- Cost every scanned PO receipt at landed cost and update the company-wide
-- SKU moving-average cost. Transfers only move existing stock and therefore
-- must not recalculate this value.
create or replace function public.receive_v2_purchase_order_lines(
  p_purchase_order_id bigint,
  p_lines jsonb,
  p_idempotency_key text,
  p_user_id bigint,
  p_user_name text
) returns jsonb language plpgsql set search_path to 'pg_catalog', 'public' as $$
declare
  v_order public.purchase_orders%rowtype;
  v_input jsonb;
  v_line public.purchase_order_lines%rowtype;
  v_product record;
  v_line_id bigint;
  v_quantity numeric;
  v_before numeric;
  v_company_before numeric;
  v_material_total numeric;
  v_quantity_total numeric;
  v_landed_unit_cost numeric;
  v_previous_amc numeric;
  v_new_amc numeric;
  v_remaining integer;
  v_received integer := 0;
begin
  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null then raise exception 'Receipt key is required'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Scan at least one expected PO item'; end if;

  if exists (
    select 1 from public.activity_events
    where document_type = 'purchase_order'
      and action_type = 'PURCHASE_ORDER_SCAN_RECEIPT'
      and metadata->>'receiptIdempotencyKey' = p_idempotency_key
  ) then
    select * into v_order from public.purchase_orders where id = p_purchase_order_id;
    return jsonb_build_object('alreadyReceived', true, 'purchaseOrderNumber', v_order.purchase_order_number, 'status', v_order.status);
  end if;

  select * into v_order from public.purchase_orders where id = p_purchase_order_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  if v_order.status not in ('ordered', 'partially_received') then raise exception 'Only a sent purchase order can be scan-received'; end if;

  -- Freight is allocated across the PO by line material value. When every line
  -- is zero-cost, fall back to quantity so 100% of freight is still captured.
  select coalesce(sum(ordered_quantity * unit_cost), 0), coalesce(sum(ordered_quantity), 0)
    into v_material_total, v_quantity_total
    from public.purchase_order_lines where purchase_order_id = v_order.id;

  for v_input in select value from jsonb_array_elements(p_lines) loop
    v_line_id := nullif(v_input->>'lineId', '')::bigint;
    v_quantity := nullif(v_input->>'quantity', '')::numeric;
    if v_line_id is null or v_quantity is null or v_quantity <= 0 then raise exception 'Each scanned line needs a positive quantity'; end if;

    select * into v_line from public.purchase_order_lines
      where id = v_line_id and purchase_order_id = v_order.id for update;
    if not found then raise exception 'Scanned item is not on this purchase order'; end if;
    if v_line.received_quantity + v_quantity > v_line.ordered_quantity then
      raise exception 'Scanned quantity exceeds the outstanding amount for PO line %', v_line.id;
    end if;

    select id, sku, name, moving_average_cost into v_product
      from public.products where id = v_line.product_id for update;
    if not found then raise exception 'Product no longer exists for PO line %', v_line.id; end if;

    v_landed_unit_cost := v_line.unit_cost + case
      when v_material_total > 0 then v_order.shipping_cost * v_line.unit_cost / v_material_total
      when v_quantity_total > 0 then v_order.shipping_cost / v_quantity_total
      else 0
    end;
    v_previous_amc := coalesce(v_product.moving_average_cost, 0);
    select coalesce(sum(quantity), 0) into v_company_before
      from public.inventory_balances where product_id = v_line.product_id;
    v_new_amc := case
      when v_company_before <= 0 then v_landed_unit_cost
      else round(((v_company_before * v_previous_amc) + (v_quantity * v_landed_unit_cost)) / (v_company_before + v_quantity), 4)
    end;

    insert into public.inventory_balances(product_id, location_id, quantity, allocated_quantity)
      values (v_line.product_id, v_order.receiving_location_id, 0, 0)
      on conflict(product_id, location_id) do nothing;
    select quantity into v_before from public.inventory_balances
      where product_id = v_line.product_id and location_id = v_order.receiving_location_id for update;
    update public.inventory_balances
      set quantity = v_before + v_quantity, updated_at = now()
      where product_id = v_line.product_id and location_id = v_order.receiving_location_id;
    update public.products set moving_average_cost = v_new_amc, updated_at = now()
      where id = v_line.product_id;
    update public.purchase_order_lines set received_quantity = received_quantity + v_quantity where id = v_line.id;

    insert into public.inventory_movements(
      product_id, location_id, movement_type, quantity_delta, quantity_before, quantity_after, unit_cost,
      reference_type, reference_id, reason, idempotency_key, performed_by_user_id, performed_by_name, metadata
    ) values (
      v_line.product_id, v_order.receiving_location_id, 'purchase_receipt', v_quantity, v_before, v_before + v_quantity, v_landed_unit_cost,
      'purchase_order', v_order.purchase_order_number, 'Scan-first PO receipt',
      p_idempotency_key || ':line:' || v_line.id, p_user_id, p_user_name,
      jsonb_build_object('purchaseOrderId', v_order.id, 'purchaseOrderLineId', v_line.id, 'sku', v_product.sku,
        'materialUnitCost', v_line.unit_cost, 'landedUnitCost', v_landed_unit_cost,
        'previousMovingAverageCost', v_previous_amc, 'newMovingAverageCost', v_new_amc)
    );
    v_received := v_received + 1;
  end loop;

  select count(*) into v_remaining from public.purchase_order_lines
    where purchase_order_id = v_order.id and received_quantity < ordered_quantity;
  update public.purchase_orders
    set status = case when v_remaining = 0 then 'received' else 'partially_received' end,
        received_at = case when v_remaining = 0 then now() else received_at end,
        updated_at = now()
    where id = v_order.id returning * into v_order;
  insert into public.activity_events(user_id, user_name, action_type, document_type, document_number, description, status, metadata)
    values (p_user_id, p_user_name, 'PURCHASE_ORDER_SCAN_RECEIPT', 'purchase_order', v_order.purchase_order_number,
      'Scan-received ' || v_received || ' PO line(s) and updated moving average cost', 'success',
      jsonb_build_object('purchaseOrderId', v_order.id, 'receivingLocationId', v_order.receiving_location_id,
        'receiptIdempotencyKey', p_idempotency_key, 'lineCount', v_received, 'costing', 'landed_moving_average'));
  return jsonb_build_object('alreadyReceived', false, 'purchaseOrderNumber', v_order.purchase_order_number,
    'status', v_order.status, 'receivedLineCount', v_received, 'remainingLineCount', v_remaining);
end $$;

revoke all on function public.receive_v2_purchase_order_lines(bigint, jsonb, text, bigint, text) from public, anon, authenticated;
grant execute on function public.receive_v2_purchase_order_lines(bigint, jsonb, text, bigint, text) to service_role;
