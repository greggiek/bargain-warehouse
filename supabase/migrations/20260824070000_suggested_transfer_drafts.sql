-- Suggested internal transfers create inventory-neutral V2 drafts.
-- Inventory is reserved only when a manager explicitly allocates the draft.

create or replace function public.create_v2_transfer_drafts(
  p_transfers jsonb,
  p_user bigint,
  p_name text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  transfer_input jsonb;
  line_input jsonb;
  v_from bigint;
  v_to bigint;
  v_product bigint;
  v_quantity numeric;
  v_transfer public.transfers%rowtype;
  v_line_count integer;
  v_result jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_transfers) <> 'array' or jsonb_array_length(p_transfers) = 0 then
    raise exception 'At least one transfer route is required';
  end if;

  for transfer_input in select value from jsonb_array_elements(p_transfers)
  loop
    v_from := nullif(transfer_input ->> 'fromLocationId', '')::bigint;
    v_to := nullif(transfer_input ->> 'toLocationId', '')::bigint;
    if v_from is null or v_to is null or v_from = v_to then
      raise exception 'Each transfer needs two different warehouses';
    end if;
    if jsonb_typeof(transfer_input -> 'lines') <> 'array'
       or jsonb_array_length(transfer_input -> 'lines') = 0 then
      raise exception 'Each transfer needs at least one item';
    end if;

    insert into public.transfers (
      from_location_id, to_location_id, status, notes, created_by_user_id, created_by_name
    )
    values (v_from, v_to, 'draft', 'Suggested internal transfer', p_user, p_name)
    returning * into v_transfer;

    v_line_count := 0;
    for line_input in select value from jsonb_array_elements(transfer_input -> 'lines')
    loop
      v_product := nullif(line_input ->> 'productId', '')::bigint;
      v_quantity := nullif(line_input ->> 'quantity', '')::numeric;
      if v_product is null or v_quantity is null or v_quantity <= 0 then
        raise exception 'Each transfer line needs a product and positive quantity';
      end if;
      if not exists (
        select 1
        from public.inventory_balances
        where product_id = v_product and location_id = v_from
      ) then
        raise exception 'Product % is not stocked at the source warehouse', v_product;
      end if;

      insert into public.transfer_lines (
        transfer_id, product_id, requested_quantity, allocated_quantity
      )
      values (v_transfer.id, v_product, v_quantity, 0);
      v_line_count := v_line_count + 1;
    end loop;

    insert into public.activity_events (
      user_id, user_name, action_type, document_type, document_number,
      warehouse_id, description, status, metadata
    )
    values (
      p_user, p_name, 'TRANSFER_DRAFTED', 'transfer', v_transfer.transfer_number,
      v_from, 'Drafted suggested transfer ' || v_transfer.transfer_number,
      'draft', jsonb_build_object('transferId', v_transfer.id, 'lineCount', v_line_count)
    );

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'id', v_transfer.id,
      'transferNumber', v_transfer.transfer_number,
      'status', v_transfer.status,
      'lineCount', v_line_count
    ));
  end loop;

  return v_result;
end;
$$;

create or replace function public.allocate_v2_transfer(
  p_transfer_id bigint,
  p_user_id bigint,
  p_user_name text
)
returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_transfer public.transfers%rowtype;
  v_line record;
  v_available numeric;
begin
  select * into v_transfer
  from public.transfers
  where id = p_transfer_id
  for update;

  if not found then
    raise exception 'Transfer not found';
  end if;
  if v_transfer.status <> 'draft' then
    raise exception 'Only draft transfers can be allocated';
  end if;

  for v_line in
    select id, product_id, requested_quantity
    from public.transfer_lines
    where transfer_id = v_transfer.id
    order by id
    for update
  loop
    select quantity - allocated_quantity
    into v_available
    from public.inventory_balances
    where product_id = v_line.product_id
      and location_id = v_transfer.from_location_id
    for update;

    if v_available is null or v_available < v_line.requested_quantity then
      raise exception 'Not enough available inventory to allocate product %', v_line.product_id;
    end if;

    update public.inventory_balances
    set allocated_quantity = allocated_quantity + v_line.requested_quantity,
        updated_at = now()
    where product_id = v_line.product_id
      and location_id = v_transfer.from_location_id;

    update public.transfer_lines
    set allocated_quantity = requested_quantity,
        updated_at = now()
    where id = v_line.id;
  end loop;

  update public.transfers
  set status = 'allocated',
      allocated_at = now(),
      updated_at = now()
  where id = v_transfer.id
  returning * into v_transfer;

  insert into public.activity_events (
    user_id, user_name, action_type, document_type, document_number,
    warehouse_id, description, status, metadata
  )
  values (
    p_user_id, p_user_name, 'TRANSFER_ALLOCATED', 'transfer', v_transfer.transfer_number,
    v_transfer.from_location_id, 'Allocated transfer ' || v_transfer.transfer_number,
    'allocated', jsonb_build_object('transferId', v_transfer.id)
  );

  return jsonb_build_object(
    'id', v_transfer.id,
    'transferNumber', v_transfer.transfer_number,
    'status', v_transfer.status
  );
end;
$$;

revoke all on function public.create_v2_transfer_drafts(jsonb,bigint,text) from public, anon, authenticated;
revoke all on function public.allocate_v2_transfer(bigint,bigint,text) from public, anon, authenticated;
grant execute on function public.create_v2_transfer_drafts(jsonb,bigint,text) to service_role;
grant execute on function public.allocate_v2_transfer(bigint,bigint,text) to service_role;
