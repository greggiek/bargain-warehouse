-- Carry forward the operational PO details used in V1.  These are V2-only
-- purchasing records; neither Shopify nor Qoblex is written from this flow.
alter table public.purchase_orders
  add column if not exists supplier_reference_number text,
  add column if not exists expected_date date,
  add column if not exists shipping_cost numeric(14, 2) not null default 0 check (shipping_cost >= 0),
  add column if not exists order_date date not null default current_date;

alter table public.purchase_order_lines
  add column if not exists uom text not null default 'EA',
  add column if not exists unit_cost numeric(14, 4) not null default 0 check (unit_cost >= 0);

create or replace function public.create_v2_purchase_order_with_details(
  p_purchase_order_number text,
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
  v_order_id bigint; v_number text; v_line jsonb; v_product_id bigint;
  v_quantity numeric; v_uom text; v_unit_cost numeric; v_count integer := 0;
  v_vendor text; v_note text;
begin
  if nullif(trim(coalesce(p_idempotency_key, '')), '') is null then raise exception 'purchase order idempotency key is required'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception 'Add at least one PO line'; end if;
  if p_shipping_cost is null or p_shipping_cost < 0 then raise exception 'Shipping cost cannot be negative'; end if;
  if p_expected_date is not null and p_order_date is not null and p_expected_date < p_order_date then raise exception 'Expected date cannot be before the PO date'; end if;

  select (metadata->>'purchaseOrderId')::bigint into v_order_id
  from public.activity_events
  where document_type = 'purchase_order' and metadata->>'idempotencyKey' = p_idempotency_key
  order by id desc limit 1;
  if v_order_id is not null then
    select purchase_order_number into v_number from public.purchase_orders where id = v_order_id;
    return jsonb_build_object('alreadyCreated', true, 'id', v_order_id, 'purchaseOrderNumber', v_number);
  end if;

  v_number := upper(trim(coalesce(p_purchase_order_number, '')));
  if v_number = '' then v_number := 'PO-' || to_char(clock_timestamp(), 'YYYYMMDD-HH24MISSMS'); end if;
  if v_number !~ '^PO-[A-Z0-9-]{4,30}$' then raise exception 'PO number must look like PO-12345'; end if;
  if exists (select 1 from public.purchase_orders where purchase_order_number = v_number) then raise exception 'That PO number already exists'; end if;

  v_vendor := nullif(trim(coalesce(p_vendor_name, '')), '');
  if v_vendor is null then raise exception 'Choose or enter a vendor'; end if;
  if length(v_vendor) > 120 then raise exception 'Vendor must be 120 characters or fewer'; end if;
  if length(trim(coalesce(p_supplier_reference_number, ''))) > 100 then raise exception 'Supplier reference must be 100 characters or fewer'; end if;
  perform 1 from public.locations where id = p_receiving_location_id and active = true;
  if not found then raise exception 'Choose an active receiving location'; end if;
  insert into public.vendors(name) select v_vendor where not exists (select 1 from public.vendors where lower(trim(name)) = lower(v_vendor));

  v_note := nullif(trim(coalesce(p_notes, '')), '');
  insert into public.purchase_orders(
    purchase_order_number, vendor_name, supplier_reference_number, receiving_location_id,
    status, notes, order_date, expected_date, shipping_cost, created_by_user_id, created_by_name
  ) values (
    v_number, v_vendor, nullif(trim(coalesce(p_supplier_reference_number, '')), ''), p_receiving_location_id,
    'draft', v_note, coalesce(p_order_date, current_date), p_expected_date, p_shipping_cost, p_user_id, p_user_name
  ) returning id into v_order_id;

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
    values (v_order_id, v_product_id, v_quantity, nullif(trim(coalesce(v_line->>'note', '')), ''), v_uom, v_unit_cost)
    on conflict (purchase_order_id, product_id) do update
      set ordered_quantity = public.purchase_order_lines.ordered_quantity + excluded.ordered_quantity,
          unit_cost = excluded.unit_cost,
          uom = excluded.uom,
          notes = coalesce(excluded.notes, public.purchase_order_lines.notes);
    v_count := v_count + 1;
  end loop;

  insert into public.activity_events(user_id, user_name, action_type, document_type, document_number, description, status, metadata)
  values (
    p_user_id, p_user_name, 'PURCHASE_ORDER_CREATED', 'purchase_order', v_number,
    'Created detailed draft purchase order', 'success',
    jsonb_build_object('purchaseOrderId', v_order_id, 'lineCount', v_count, 'receivingLocationId', p_receiving_location_id, 'idempotencyKey', p_idempotency_key, 'supplierReferenceNumber', nullif(trim(coalesce(p_supplier_reference_number, '')), ''), 'expectedDate', p_expected_date, 'shippingCost', p_shipping_cost)
  );
  return jsonb_build_object('alreadyCreated', false, 'id', v_order_id, 'purchaseOrderNumber', v_number, 'status', 'draft');
end $$;

revoke all on function public.create_v2_purchase_order_with_details(text, text, text, bigint, date, date, numeric, jsonb, text, text, bigint, text) from public, anon, authenticated;
grant execute on function public.create_v2_purchase_order_with_details(text, text, text, bigint, date, date, numeric, jsonb, text, text, bigint, text) to service_role;
