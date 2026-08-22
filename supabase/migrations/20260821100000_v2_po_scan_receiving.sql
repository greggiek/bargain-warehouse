-- PO master and scan-first receiving. Purchases normally land at 730, but an
-- admin may explicitly create a direct-to-retail PO when needed.
alter table public.purchase_orders
  add column if not exists sent_at timestamptz,
  add column if not exists sent_by_user_id bigint references public.app_users(id) on delete set null,
  add column if not exists sent_by_name text;

create index if not exists purchase_orders_receiving_status_idx
  on public.purchase_orders(receiving_location_id, status, created_at desc);

create or replace function public.send_v2_purchase_order(
  p_purchase_order_id bigint,
  p_user_id bigint,
  p_user_name text
) returns jsonb language plpgsql set search_path to 'pg_catalog', 'public' as $$
declare v_order public.purchase_orders%rowtype; v_line_count integer; v_already_sent boolean;
begin
  select * into v_order from public.purchase_orders where id = p_purchase_order_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  if v_order.status in ('cancelled', 'received') then raise exception 'This purchase order can no longer be sent'; end if;
  select count(*) into v_line_count from public.purchase_order_lines where purchase_order_id = v_order.id;
  if v_line_count = 0 then raise exception 'Add at least one line before sending this purchase order'; end if;

  v_already_sent := v_order.status <> 'draft';
  if not v_already_sent then
    update public.purchase_orders
      set status = 'ordered', ordered_at = coalesce(ordered_at, now()), sent_at = now(),
          sent_by_user_id = p_user_id, sent_by_name = p_user_name, updated_at = now()
      where id = v_order.id
      returning * into v_order;
    insert into public.activity_events(user_id, user_name, action_type, document_type, document_number, description, status, metadata)
      values (p_user_id, p_user_name, 'PURCHASE_ORDER_SENT', 'purchase_order', v_order.purchase_order_number,
        'Sent purchase order to supplier', 'success',
        jsonb_build_object('purchaseOrderId', v_order.id, 'receivingLocationId', v_order.receiving_location_id));
  end if;
  return jsonb_build_object('id', v_order.id, 'purchaseOrderNumber', v_order.purchase_order_number, 'status', v_order.status, 'alreadySent', v_already_sent);
end $$;

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
  v_remaining integer;
  v_received integer := 0;
begin
  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null then raise exception 'Receipt key is required'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Scan at least one expected PO item'; end if;

  -- A retry after a network failure must not double-receive physical inventory.
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
  if v_order.status not in ('ordered', 'partially_received') then
    raise exception 'Only a sent purchase order can be scan-received';
  end if;

  for v_input in select value from jsonb_array_elements(p_lines) loop
    v_line_id := nullif(v_input->>'lineId', '')::bigint;
    v_quantity := nullif(v_input->>'quantity', '')::numeric;
    if v_line_id is null or v_quantity is null or v_quantity <= 0 then
      raise exception 'Each scanned line needs a positive quantity';
    end if;

    select * into v_line from public.purchase_order_lines
      where id = v_line_id and purchase_order_id = v_order.id for update;
    if not found then raise exception 'Scanned item is not on this purchase order'; end if;
    if v_line.received_quantity + v_quantity > v_line.ordered_quantity then
      raise exception 'Scanned quantity exceeds the outstanding amount for PO line %', v_line.id;
    end if;
    select id, sku, name into v_product from public.products where id = v_line.product_id;

    insert into public.inventory_balances(product_id, location_id, quantity, allocated_quantity)
      values (v_line.product_id, v_order.receiving_location_id, 0, 0)
      on conflict(product_id, location_id) do nothing;
    select quantity into v_before from public.inventory_balances
      where product_id = v_line.product_id and location_id = v_order.receiving_location_id for update;
    update public.inventory_balances
      set quantity = v_before + v_quantity, updated_at = now()
      where product_id = v_line.product_id and location_id = v_order.receiving_location_id;
    update public.purchase_order_lines
      set received_quantity = received_quantity + v_quantity
      where id = v_line.id;
    insert into public.inventory_movements(
      product_id, location_id, movement_type, quantity_delta, quantity_before, quantity_after,
      reference_type, reference_id, reason, idempotency_key, performed_by_user_id, performed_by_name, metadata
    ) values (
      v_line.product_id, v_order.receiving_location_id, 'purchase_receipt', v_quantity, v_before, v_before + v_quantity,
      'purchase_order', v_order.purchase_order_number, 'Scan-first PO receipt',
      p_idempotency_key || ':line:' || v_line.id, p_user_id, p_user_name,
      jsonb_build_object('purchaseOrderId', v_order.id, 'purchaseOrderLineId', v_line.id, 'sku', v_product.sku)
    );
    v_received := v_received + 1;
  end loop;

  select count(*) into v_remaining
    from public.purchase_order_lines
    where purchase_order_id = v_order.id and received_quantity < ordered_quantity;
  update public.purchase_orders
    set status = case when v_remaining = 0 then 'received' else 'partially_received' end,
        received_at = case when v_remaining = 0 then now() else received_at end,
        updated_at = now()
    where id = v_order.id
    returning * into v_order;
  insert into public.activity_events(user_id, user_name, action_type, document_type, document_number, description, status, metadata)
    values (p_user_id, p_user_name, 'PURCHASE_ORDER_SCAN_RECEIPT', 'purchase_order', v_order.purchase_order_number,
      'Scan-received ' || v_received || ' PO line(s)', 'success',
      jsonb_build_object('purchaseOrderId', v_order.id, 'receivingLocationId', v_order.receiving_location_id,
        'receiptIdempotencyKey', p_idempotency_key, 'lineCount', v_received));
  return jsonb_build_object('alreadyReceived', false, 'purchaseOrderNumber', v_order.purchase_order_number,
    'status', v_order.status, 'receivedLineCount', v_received, 'remainingLineCount', v_remaining);
end $$;

revoke all on function public.send_v2_purchase_order(bigint, bigint, text) from public, anon, authenticated;
revoke all on function public.receive_v2_purchase_order_lines(bigint, jsonb, text, bigint, text) from public, anon, authenticated;
grant execute on function public.send_v2_purchase_order(bigint, bigint, text) to service_role;
grant execute on function public.receive_v2_purchase_order_lines(bigint, jsonb, text, bigint, text) to service_role;
