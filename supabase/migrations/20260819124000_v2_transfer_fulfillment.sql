-- V2 transfer fulfillment: shipment and receipt are ledger-only, atomic, and service-role callable.
create or replace function public.ship_v2_transfer(p_transfer_id bigint, p_user_id bigint, p_user_name text)
returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare t public.transfers%rowtype; l record; before_qty numeric; after_qty numeric; ship_qty numeric;
begin
  select * into t from public.transfers where id=p_transfer_id for update;
  if not found then raise exception 'Transfer not found'; end if;
  if t.status <> 'allocated' then raise exception 'Only allocated transfers can be shipped'; end if;
  for l in select * from public.transfer_lines where transfer_id=t.id order by id for update loop
    ship_qty := l.allocated_quantity-l.shipped_quantity;
    if ship_qty <= 0 then continue; end if;
    select quantity into before_qty from public.inventory_balances where product_id=l.product_id and location_id=t.from_location_id for update;
    if coalesce(before_qty,0) < ship_qty then raise exception 'Insufficient on-hand inventory while shipping product %', l.product_id; end if;
    update public.inventory_balances set quantity=quantity-ship_qty, allocated_quantity=allocated_quantity-ship_qty, updated_at=now()
      where product_id=l.product_id and location_id=t.from_location_id returning quantity into after_qty;
    update public.transfer_lines set shipped_quantity=shipped_quantity+ship_qty, updated_at=now() where id=l.id;
    insert into public.inventory_movements(product_id,location_id,movement_type,quantity_delta,quantity_before,quantity_after,reference_type,reference_id,reason,idempotency_key,performed_by_user_id,performed_by_name,metadata)
      values(l.product_id,t.from_location_id,'transfer_ship',-ship_qty,before_qty,after_qty,'transfer',t.transfer_number,'Transfer shipment','transfer:'||t.id||':ship:'||l.id,p_user_id,p_user_name,jsonb_build_object('transferId',t.id,'transferNumber',t.transfer_number,'toLocationId',t.to_location_id));
  end loop;
  update public.transfers set status='in_transit', shipped_at=now(), updated_at=now() where id=t.id;
  insert into public.activity_events(user_id,user_name,action_type,document_type,document_number,description,status,metadata)
    values(p_user_id,p_user_name,'TRANSFER_SHIPPED','transfer',t.transfer_number,'Shipped transfer '||t.transfer_number,'success',jsonb_build_object('transferId',t.id));
  return jsonb_build_object('id',t.id,'transferNumber',t.transfer_number,'status','in_transit');
end $$;

create or replace function public.receive_v2_transfer(p_transfer_id bigint, p_user_id bigint, p_user_name text)
returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare t public.transfers%rowtype; l record; before_qty numeric; after_qty numeric; receive_qty numeric;
begin
  select * into t from public.transfers where id=p_transfer_id for update;
  if not found then raise exception 'Transfer not found'; end if;
  if t.status <> 'in_transit' then raise exception 'Only in-transit transfers can be received'; end if;
  for l in select * from public.transfer_lines where transfer_id=t.id order by id for update loop
    receive_qty := l.shipped_quantity-l.received_quantity-l.damaged_quantity-l.missing_quantity;
    if receive_qty <= 0 then continue; end if;
    insert into public.inventory_balances(product_id,location_id,quantity,allocated_quantity,updated_at)
      values(l.product_id,t.to_location_id,0,0,now()) on conflict(product_id,location_id) do nothing;
    select quantity into before_qty from public.inventory_balances where product_id=l.product_id and location_id=t.to_location_id for update;
    update public.inventory_balances set quantity=quantity+receive_qty, updated_at=now()
      where product_id=l.product_id and location_id=t.to_location_id returning quantity into after_qty;
    update public.transfer_lines set received_quantity=received_quantity+receive_qty, updated_at=now() where id=l.id;
    insert into public.inventory_movements(product_id,location_id,movement_type,quantity_delta,quantity_before,quantity_after,reference_type,reference_id,reason,idempotency_key,performed_by_user_id,performed_by_name,metadata)
      values(l.product_id,t.to_location_id,'transfer_receive',receive_qty,before_qty,after_qty,'transfer',t.transfer_number,'Transfer receipt','transfer:'||t.id||':receive:'||l.id,p_user_id,p_user_name,jsonb_build_object('transferId',t.id,'transferNumber',t.transfer_number,'fromLocationId',t.from_location_id));
  end loop;
  update public.transfers set status='completed', received_at=now(), updated_at=now() where id=t.id;
  insert into public.activity_events(user_id,user_name,action_type,document_type,document_number,description,status,metadata)
    values(p_user_id,p_user_name,'TRANSFER_RECEIVED','transfer',t.transfer_number,'Received transfer '||t.transfer_number,'success',jsonb_build_object('transferId',t.id));
  return jsonb_build_object('id',t.id,'transferNumber',t.transfer_number,'status','completed');
end $$;

revoke execute on function public.ship_v2_transfer(bigint,bigint,text) from public,anon,authenticated;
revoke execute on function public.receive_v2_transfer(bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.ship_v2_transfer(bigint,bigint,text) to service_role;
grant execute on function public.receive_v2_transfer(bigint,bigint,text) to service_role;
