-- Admin-only edits for open POs. Receipt history and received quantities are
-- immutable; only the outstanding supplier commitment may be changed.
create or replace function public.update_v2_open_purchase_order_with_details(
  p_purchase_order_id bigint,
  p_vendor_name text,
  p_supplier_reference_number text,
  p_receiving_location_id bigint,
  p_order_date date,
  p_expected_date date,
  p_shipping_cost numeric,
  p_lines jsonb,
  p_notes text,
  p_idempotency_key text,
  p_user_id bigint,
  p_user_name text
) returns jsonb language plpgsql set search_path to 'pg_catalog', 'public' as $$
declare
  v_order public.purchase_orders%rowtype;
  v_line jsonb;
  v_product_id bigint;
  v_quantity numeric;
  v_uom text;
  v_unit_cost numeric;
  v_vendor text;
  v_note text;
  v_line_count integer := 0;
begin
  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null then raise exception 'purchase order idempotency key is required'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Add at least one PO line'; end if;
  if p_shipping_cost is null or p_shipping_cost < 0 then raise exception 'Shipping cost cannot be negative'; end if;
  if p_expected_date is not null and p_order_date is not null and p_expected_date < p_order_date then raise exception 'Expected date cannot be before the PO date'; end if;

  select * into v_order from public.purchase_orders where id = p_purchase_order_id for update;
  if not found then raise exception 'Purchase order not found'; end if;
  if v_order.status not in ('ordered', 'partially_received') then raise exception 'Only an open purchase order can be edited'; end if;

  if exists (
    select 1 from public.activity_events
    where document_type = 'purchase_order'
      and action_type = 'PURCHASE_ORDER_UPDATED'
      and metadata->>'idempotencyKey' = p_idempotency_key
  ) then
    return jsonb_build_object('alreadyUpdated', true, 'id', v_order.id, 'purchaseOrderNumber', v_order.purchase_order_number, 'status', v_order.status);
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_lines) value
    group by (value->>'productId')::bigint
    having count(*) > 1
  ) then raise exception 'Each product can appear only once on a purchase order'; end if;

  if exists (
    select 1
    from public.purchase_order_lines existing
    where existing.purchase_order_id = v_order.id
      and existing.received_quantity > 0
      and not exists (
        select 1 from jsonb_array_elements(p_lines) value
        where (value->>'productId')::bigint = existing.product_id
      )
  ) then raise exception 'A received PO line cannot be removed'; end if;

  if exists (
    select 1
    from public.purchase_order_lines existing
    join lateral jsonb_array_elements(p_lines) value on (value->>'productId')::bigint = existing.product_id
    where existing.purchase_order_id = v_order.id
      and ((value->>'quantity')::numeric < existing.received_quantity)
  ) then raise exception 'An ordered quantity cannot be below its received quantity'; end if;

  if p_receiving_location_id <> v_order.receiving_location_id and exists (
    select 1 from public.purchase_order_lines where purchase_order_id = v_order.id and received_quantity > 0
  ) then raise exception 'The receiving location cannot change after receiving starts'; end if;

  v_vendor := nullif(trim(coalesce(p_vendor_name, '')), '');
  if v_vendor is null then raise exception 'Choose or enter a vendor'; end if;
  if length(v_vendor) > 120 then raise exception 'Vendor must be 120 characters or fewer'; end if;
  if length(trim(coalesce(p_supplier_reference_number, ''))) > 100 then raise exception 'Supplier reference must be 100 characters or fewer'; end if;
  perform 1 from public.locations where id = p_receiving_location_id and active = true;
  if not found then raise exception 'Choose an active receiving location'; end if;
  insert into public.vendors(name) select v_vendor where not exists (select 1 from public.vendors where lower(trim(name)) = lower(v_vendor));

  v_note := nullif(trim(coalesce(p_notes, '')), '');
  update public.purchase_orders
    set vendor_name = v_vendor,
        supplier_reference_number = nullif(trim(coalesce(p_supplier_reference_number, '')), ''),
        receiving_location_id = p_receiving_location_id,
        order_date = coalesce(p_order_date, current_date),
        expected_date = p_expected_date,
        shipping_cost = p_shipping_cost,
        notes = v_note,
        updated_at = now()
    where id = v_order.id;

  delete from public.purchase_order_lines existing
  where existing.purchase_order_id = v_order.id
    and existing.received_quantity = 0
    and not exists (
      select 1 from jsonb_array_elements(p_lines) value
      where (value->>'productId')::bigint = existing.product_id
    );

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_product_id := (v_line->>'productId')::bigint;
    v_quantity := (v_line->>'quantity')::numeric;
    v_uom := upper(left(coalesce(nullif(trim(v_line->>'uom'), ''), 'EA'), 16));
    v_unit_cost := coalesce((v_line->>'unitCost')::numeric, 0);
    if v_quantity is null or v_quantity <= 0 then raise exception 'Purchase quantities must be positive'; end if;
    if v_unit_cost < 0 then raise exception 'Unit cost cannot be negative'; end if;
    perform 1 from public.products where id = v_product_id and active = true;
    if not found then raise exception 'Selected product is not active'; end if;
    insert into public.purchase_order_lines(purchase_order_id, product_id, ordered_quantity, notes, uom, unit_cost)
    values (v_order.id, v_product_id, v_quantity, nullif(trim(coalesce(v_line->>'note', '')), ''), v_uom, v_unit_cost)
    on conflict (purchase_order_id, product_id) do update
      set ordered_quantity = excluded.ordered_quantity,
          unit_cost = excluded.unit_cost,
          uom = excluded.uom,
          notes = coalesce(excluded.notes, public.purchase_order_lines.notes);
    v_line_count := v_line_count + 1;
  end loop;

  insert into public.activity_events(user_id, user_name, action_type, document_type, document_number, description, status, metadata)
  values (
    p_user_id, p_user_name, 'PURCHASE_ORDER_UPDATED', 'purchase_order', v_order.purchase_order_number,
    'Updated open purchase order; received lines retained', 'success',
    jsonb_build_object('purchaseOrderId', v_order.id, 'lineCount', v_line_count, 'receivingLocationId', p_receiving_location_id, 'idempotencyKey', p_idempotency_key)
  );
  return jsonb_build_object('alreadyUpdated', false, 'id', v_order.id, 'purchaseOrderNumber', v_order.purchase_order_number, 'status', v_order.status);
end $$;

revoke all on function public.update_v2_open_purchase_order_with_details(bigint, text, text, bigint, date, date, numeric, jsonb, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.update_v2_open_purchase_order_with_details(bigint, text, text, bigint, date, date, numeric, jsonb, text, text, bigint, text) to service_role;
