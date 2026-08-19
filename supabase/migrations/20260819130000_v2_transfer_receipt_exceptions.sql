-- Records partial receipts and transit discrepancies in the V2 ledger.
create or replace function public.receive_v2_transfer_details(p_transfer_id bigint, p_lines jsonb, p_user_id bigint, p_user_name text)
returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare t public.transfers%rowtype; input jsonb; l public.transfer_lines%rowtype; received_now numeric; damaged_now numeric; missing_now numeric; outstanding numeric; before_qty numeric; after_qty numeric; remaining_count integer; discrepancy_count integer:=0;
begin
  select * into t from public.transfers where id=p_transfer_id for update;
  if not found then raise exception 'Transfer not found'; end if;
  if t.status not in ('in_transit','partially_received') then raise exception 'Only in-transit or partially received transfers can be received'; end if;
  if jsonb_array_length(p_lines)=0 then raise exception 'At least one receipt line is required'; end if;
  for input in select value from jsonb_array_elements(p_lines) loop
    select * into l from public.transfer_lines where id=(input->>'lineId')::bigint and transfer_id=t.id for update;
    if not found then raise exception 'Transfer line not found'; end if;
    received_now:=coalesce((input->>'receivedQuantity')::numeric,0); damaged_now:=coalesce((input->>'damagedQuantity')::numeric,0); missing_now:=coalesce((input->>'missingQuantity')::numeric,0);
    if received_now<0 or damaged_now<0 or missing_now<0 then raise exception 'Receipt quantities cannot be negative'; end if;
    outstanding:=l.shipped_quantity-l.received_quantity-l.damaged_quantity-l.missing_quantity;
    if received_now+damaged_now+missing_now<=0 then raise exception 'Enter a received, damaged, or missing quantity'; end if;
    if received_now+damaged_now+missing_now>outstanding then raise exception 'Receipt exceeds outstanding quantity'; end if;
    if received_now>0 then
      insert into public.inventory_balances(product_id,location_id,quantity,allocated_quantity,updated_at) values(l.product_id,t.to_location_id,0,0,now()) on conflict(product_id,location_id) do nothing;
      select quantity into before_qty from public.inventory_balances where product_id=l.product_id and location_id=t.to_location_id for update;
      update public.inventory_balances set quantity=quantity+received_now,updated_at=now() where product_id=l.product_id and location_id=t.to_location_id returning quantity into after_qty;
      insert into public.inventory_movements(product_id,location_id,movement_type,quantity_delta,quantity_before,quantity_after,reference_type,reference_id,reason,idempotency_key,performed_by_user_id,performed_by_name,metadata)
        values(l.product_id,t.to_location_id,'transfer_receive',received_now,before_qty,after_qty,'transfer',t.transfer_number,'Transfer receipt','transfer:'||t.id||':receive:'||l.id||':'||(l.received_quantity+received_now),p_user_id,p_user_name,jsonb_build_object('transferId',t.id,'transferNumber',t.transfer_number,'fromLocationId',t.from_location_id));
    end if;
    update public.transfer_lines set received_quantity=received_quantity+received_now,damaged_quantity=damaged_quantity+damaged_now,missing_quantity=missing_quantity+missing_now,notes=coalesce(nullif(input->>'note',''),notes),updated_at=now() where id=l.id;
    if damaged_now>0 then insert into public.transfer_discrepancies(transfer_id,transfer_line_id,discrepancy_type,quantity,note,reported_by_user_id) values(t.id,l.id,'damaged',damaged_now,nullif(input->>'note',''),p_user_id); discrepancy_count:=discrepancy_count+1; end if;
    if missing_now>0 then insert into public.transfer_discrepancies(transfer_id,transfer_line_id,discrepancy_type,quantity,note,reported_by_user_id) values(t.id,l.id,'missing',missing_now,nullif(input->>'note',''),p_user_id); discrepancy_count:=discrepancy_count+1; end if;
  end loop;
  select count(*) into remaining_count from public.transfer_lines where transfer_id=t.id and shipped_quantity>received_quantity+damaged_quantity+missing_quantity;
  update public.transfers set status=case when remaining_count>0 then 'partially_received' when discrepancy_count>0 or exists(select 1 from public.transfer_discrepancies where transfer_id=t.id and resolved_at is null) then 'problem' else 'completed' end,received_at=case when remaining_count=0 then now() else received_at end,updated_at=now() where id=t.id returning * into t;
  insert into public.activity_events(user_id,user_name,action_type,document_type,document_number,description,status,metadata) values(p_user_id,p_user_name,'TRANSFER_RECEIPT_RECORDED','transfer',t.transfer_number,'Recorded receipt for transfer '||t.transfer_number,case when t.status='problem' then 'warning' else 'success' end,jsonb_build_object('transferId',t.id,'status',t.status,'discrepancies',discrepancy_count));
  return jsonb_build_object('id',t.id,'transferNumber',t.transfer_number,'status',t.status,'discrepancies',discrepancy_count);
end $$;
revoke execute on function public.receive_v2_transfer_details(bigint,jsonb,bigint,text) from public,anon,authenticated;
grant execute on function public.receive_v2_transfer_details(bigint,jsonb,bigint,text) to service_role;
