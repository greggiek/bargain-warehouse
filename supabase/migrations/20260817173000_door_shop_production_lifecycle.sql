alter table public.door_shop_work_orders
  add column if not exists source_type text not null default 'manual',
  add column if not exists source_store text,
  add column if not exists source_order_id text,
  add column if not exists final_location_id uuid references public.warehouse_locations(id),
  add column if not exists production_location_id uuid references public.warehouse_locations(id),
  add column if not exists transfer_id uuid references public.transfers(id),
  add column if not exists allocation_started_at timestamptz;

create unique index if not exists door_shop_work_orders_shopify_source_uidx
  on public.door_shop_work_orders(source_store,source_order_id)
  where source_order_id is not null;

create table if not exists public.door_shop_work_order_allocations (
  id bigint generated always as identity primary key,
  work_order_id bigint not null references public.door_shop_work_orders(id) on delete cascade,
  product_id uuid not null references public.products(id),
  component_sku text not null,
  required_quantity numeric(16,4) not null check(required_quantity > 0),
  consumed_quantity numeric(16,4) not null default 0 check(consumed_quantity >= 0),
  created_at timestamptz not null default now(),
  consumed_at timestamptz,
  unique(work_order_id,product_id)
);
alter table public.door_shop_work_order_allocations enable row level security;
revoke all on public.door_shop_work_order_allocations from anon,authenticated;

create or replace function public.start_door_shop_work_order(
  p_work_order_id bigint,
  p_actor_name text,
  p_actor_email text default null
) returns jsonb
language plpgsql
set search_path=public
as $$
declare
  v_order public.door_shop_work_orders%rowtype;
  v_windham uuid;
  v_missing integer;
begin
  select * into v_order from public.door_shop_work_orders where id=p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  if v_order.status <> 'draft' then raise exception 'Only a draft work order can start production'; end if;
  select id into v_windham from public.warehouse_locations where name='730 Windham Rd' and active=true limit 1;
  if v_windham is null then raise exception '730 Windham Rd is not configured'; end if;

  select count(*) into v_missing
  from public.door_shop_work_order_boms wb
  where wb.work_order_id=v_order.id and (wb.catalog_bom_id is null or not exists(
    select 1 from public.door_shop_catalog_components c where c.qoblex_variant_id=wb.catalog_bom_id
  ));
  if v_missing > 0 then raise exception '% work-order line(s) need a catalog BOM with components',v_missing; end if;

  insert into public.products(sku,name,uom,active,purchase_price,moving_average_cost)
  select distinct upper(c.component_sku),upper(c.component_sku),'EA',true,0,0
  from public.door_shop_work_order_boms wb
  join public.door_shop_catalog_components c on c.qoblex_variant_id=wb.catalog_bom_id
  where wb.work_order_id=v_order.id
  on conflict(sku) do nothing;

  insert into public.products(sku,name,uom,active,purchase_price,moving_average_cost)
  select distinct upper(cb.sku),cb.variant_name,'EA',true,0,0
  from public.door_shop_work_order_boms wb
  join public.door_shop_catalog_boms cb on cb.qoblex_variant_id=wb.catalog_bom_id
  where wb.work_order_id=v_order.id
  on conflict(sku) do nothing;

  insert into public.inventory_balances(product_id,location_id,quantity,allocated_quantity,updated_at)
  select distinct p.id,v_windham,0,0,now()
  from public.door_shop_work_order_boms wb
  join public.door_shop_catalog_components c on c.qoblex_variant_id=wb.catalog_bom_id
  join public.products p on upper(p.sku)=upper(c.component_sku)
  where wb.work_order_id=v_order.id
  on conflict(product_id,location_id) do nothing;

  insert into public.door_shop_work_order_allocations(work_order_id,product_id,component_sku,required_quantity)
  select v_order.id,p.id,upper(c.component_sku),sum(wb.quantity*c.quantity_per_unit)
  from public.door_shop_work_order_boms wb
  join public.door_shop_catalog_components c on c.qoblex_variant_id=wb.catalog_bom_id
  join public.products p on upper(p.sku)=upper(c.component_sku)
  where wb.work_order_id=v_order.id
  group by p.id,upper(c.component_sku);

  update public.inventory_balances ib
  set allocated_quantity=ib.allocated_quantity+a.required_quantity,updated_at=now()
  from public.door_shop_work_order_allocations a
  where a.work_order_id=v_order.id and ib.product_id=a.product_id and ib.location_id=v_windham;

  update public.door_shop_work_orders
  set status='in_production',production_location_id=v_windham,allocation_started_at=now(),updated_at=now()
  where id=v_order.id;

  return jsonb_build_object(
    'status','in_production','production_location','730 Windham Rd',
    'shortages',coalesce((select jsonb_agg(jsonb_build_object(
      'sku',a.component_sku,'required',a.required_quantity,'on_hand',ib.quantity,
      'short',greatest(a.required_quantity-ib.quantity,0)
    )) from public.door_shop_work_order_allocations a
      join public.inventory_balances ib on ib.product_id=a.product_id and ib.location_id=v_windham
      where a.work_order_id=v_order.id and ib.quantity<a.required_quantity),'[]'::jsonb)
  );
end $$;

create or replace function public.complete_door_shop_work_order(
  p_work_order_id bigint,
  p_actor_name text,
  p_actor_email text default null
) returns jsonb
language plpgsql
set search_path=public
as $$
declare
  v_order public.door_shop_work_orders%rowtype;
  v_windham uuid;
  v_shortages jsonb;
  v_row record;
  v_before numeric(16,4);
  v_after numeric(16,4);
begin
  select * into v_order from public.door_shop_work_orders where id=p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  if v_order.status <> 'in_production' then raise exception 'Only an in-production work order can be completed'; end if;
  v_windham:=v_order.production_location_id;
  if v_windham is null then raise exception 'Production location is missing'; end if;

  select coalesce(jsonb_agg(jsonb_build_object('sku',a.component_sku,'required',a.required_quantity,'on_hand',coalesce(ib.quantity,0))),'[]'::jsonb)
    into v_shortages
  from public.door_shop_work_order_allocations a
  left join public.inventory_balances ib on ib.product_id=a.product_id and ib.location_id=v_windham
  where a.work_order_id=v_order.id and coalesce(ib.quantity,0)<a.required_quantity;
  if jsonb_array_length(v_shortages)>0 then raise exception 'Insufficient component inventory: %',v_shortages::text; end if;

  for v_row in select a.*,ib.quantity from public.door_shop_work_order_allocations a
    join public.inventory_balances ib on ib.product_id=a.product_id and ib.location_id=v_windham
    where a.work_order_id=v_order.id for update of ib,a
  loop
    v_before:=v_row.quantity;v_after:=v_before-v_row.required_quantity;
    update public.inventory_balances set quantity=v_after,allocated_quantity=greatest(0,allocated_quantity-v_row.required_quantity),updated_at=now()
      where product_id=v_row.product_id and location_id=v_windham;
    update public.door_shop_work_order_allocations set consumed_quantity=required_quantity,consumed_at=now() where id=v_row.id;
    insert into public.inventory_movements(product_id,location_id,movement_type,quantity_delta,quantity_before,quantity_after,reference_type,reference_id,reason,employee_name,metadata)
      values(v_row.product_id,v_windham,'production_consumption',-v_row.required_quantity,v_before,v_after,'door_shop_work_order',v_order.work_order_number,'Door Shop component consumption',p_actor_name,jsonb_build_object('employee_email',p_actor_email));
  end loop;

  for v_row in
    select p.id product_id,upper(cb.sku) sku,sum(wb.quantity) quantity
    from public.door_shop_work_order_boms wb
    join public.door_shop_catalog_boms cb on cb.qoblex_variant_id=wb.catalog_bom_id
    join public.products p on upper(p.sku)=upper(cb.sku)
    where wb.work_order_id=v_order.id group by p.id,upper(cb.sku)
  loop
    insert into public.inventory_balances(product_id,location_id,quantity,allocated_quantity,updated_at)
      values(v_row.product_id,v_windham,v_row.quantity,0,now())
      on conflict(product_id,location_id) do update set quantity=public.inventory_balances.quantity+excluded.quantity,updated_at=now()
      returning quantity-v_row.quantity,quantity into v_before,v_after;
    insert into public.inventory_movements(product_id,location_id,movement_type,quantity_delta,quantity_before,quantity_after,reference_type,reference_id,reason,employee_name,metadata)
      values(v_row.product_id,v_windham,'production_output',v_row.quantity,v_before,v_after,'door_shop_work_order',v_order.work_order_number,'Door Shop finished production',p_actor_name,jsonb_build_object('employee_email',p_actor_email,'parent_sku',v_row.sku));
  end loop;

  update public.door_shop_work_orders set status='complete',completed_at=now(),completed_by_name=p_actor_name,completed_by_email=p_actor_email,updated_at=now() where id=v_order.id;
  return jsonb_build_object('status','complete','production_location','730 Windham Rd');
end $$;

create or replace function public.create_door_shop_transfer(
  p_work_order_id bigint,
  p_actor_name text,
  p_actor_email text default null
) returns jsonb
language plpgsql
set search_path=public
as $$
declare
  v_order public.door_shop_work_orders%rowtype;
  v_transfer public.transfers%rowtype;
  v_number text;
begin
  select * into v_order from public.door_shop_work_orders where id=p_work_order_id for update;
  if not found then raise exception 'Work order not found'; end if;
  if v_order.status<>'complete' then raise exception 'Complete the work order before creating its transfer'; end if;
  if v_order.final_location_id is null then raise exception 'Final location is required'; end if;
  if v_order.production_location_id=v_order.final_location_id then return jsonb_build_object('status','not_required','message','Finished inventory is already at its final location'); end if;
  if v_order.transfer_id is not null then
    select * into v_transfer from public.transfers where id=v_order.transfer_id;
    return jsonb_build_object('status','existing','transfer_id',v_transfer.id,'transfer_number',v_transfer.transfer_number);
  end if;
  v_number:='TR-'||to_char(now(),'YYYYMMDD')||'-'||lpad(v_order.id::text,9,'0');
  insert into public.transfers(transfer_number,from_location_id,to_location_id,status,notes,created_by_name,created_by_email,updated_at)
    values(v_number,v_order.production_location_id,v_order.final_location_id,'awaiting_receipt','Created from '||v_order.work_order_number,p_actor_name,p_actor_email,now())
    returning * into v_transfer;
  insert into public.transfer_lines(transfer_id,product_id,requested_qty,shipped_qty,received_qty)
  select v_transfer.id,p.id,sum(wb.quantity),sum(wb.quantity),0
  from public.door_shop_work_order_boms wb
  join public.door_shop_catalog_boms cb on cb.qoblex_variant_id=wb.catalog_bom_id
  join public.products p on upper(p.sku)=upper(cb.sku)
  where wb.work_order_id=v_order.id group by p.id;
  update public.door_shop_work_orders set transfer_id=v_transfer.id,updated_at=now() where id=v_order.id;
  return jsonb_build_object('status','created','transfer_id',v_transfer.id,'transfer_number',v_transfer.transfer_number);
end $$;

revoke all on function public.start_door_shop_work_order(bigint,text,text) from public,anon,authenticated;
revoke all on function public.complete_door_shop_work_order(bigint,text,text) from public,anon,authenticated;
revoke all on function public.create_door_shop_transfer(bigint,text,text) from public,anon,authenticated;
grant execute on function public.start_door_shop_work_order(bigint,text,text) to service_role;
grant execute on function public.complete_door_shop_work_order(bigint,text,text) to service_role;
grant execute on function public.create_door_shop_transfer(bigint,text,text) to service_role;