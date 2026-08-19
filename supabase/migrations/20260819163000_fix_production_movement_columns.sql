-- Fix V2 production movement column names to match the inventory ledger schema.
create or replace function public.complete_v2_production(
  p_bom_id bigint, p_location_id bigint, p_output_quantity numeric, p_reference text,
  p_idempotency_key text, p_user_id bigint, p_user_name text
) returns jsonb language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  v_bom public.product_boms%rowtype; v_finished public.products%rowtype; v_component record;
  v_before numeric; v_allocated numeric; v_needed numeric; v_on_hand numeric; v_shortages jsonb := '[]'::jsonb;
begin
  if p_output_quantity is null or p_output_quantity <= 0 then raise exception 'output quantity must be greater than zero'; end if;
  if p_location_id is null then raise exception 'production location is required'; end if;
  if nullif(trim(coalesce(p_idempotency_key,'')),'') is null then raise exception 'idempotency key is required'; end if;
  if exists (select 1 from public.inventory_movements where idempotency_key=p_idempotency_key||':complete') then return jsonb_build_object('alreadyCompleted',true); end if;
  select * into v_bom from public.product_boms where id=p_bom_id and active=true for update;
  if not found then raise exception 'active BOM not found'; end if;
  select * into v_finished from public.products where id=v_bom.finished_product_id and active=true;
  if not found then raise exception 'finished product not found'; end if;
  if not exists(select 1 from public.product_bom_components where bom_id=v_bom.id) then raise exception 'BOM needs at least one component'; end if;
  for v_component in select c.component_product_id,c.quantity_per_yield,p.sku,p.name from public.product_bom_components c join public.products p on p.id=c.component_product_id where c.bom_id=v_bom.id and p.active=true order by c.component_product_id loop
    v_needed := p_output_quantity*v_component.quantity_per_yield/v_bom.yield_quantity;
    insert into public.inventory_balances(product_id,location_id,quantity,allocated_quantity) values(v_component.component_product_id,p_location_id,0,0) on conflict(product_id,location_id) do nothing;
    select quantity,allocated_quantity into v_before,v_allocated from public.inventory_balances where product_id=v_component.component_product_id and location_id=p_location_id for update;
    if v_before-v_needed<0 and v_allocated>0 then raise exception 'cannot consume allocated component %',v_component.sku; end if;
    update public.inventory_balances set quantity=v_before-v_needed,updated_at=now() where product_id=v_component.component_product_id and location_id=p_location_id;
    insert into public.inventory_movements(product_id,location_id,movement_type,quantity_delta,quantity_before,quantity_after,reference_type,reference_id,reason,idempotency_key,performed_by_user_id,performed_by_name,metadata)
      values(v_component.component_product_id,p_location_id,'production_consume',-v_needed,v_before,v_before-v_needed,'production',nullif(trim(p_reference),''),'Production consumption for '||v_finished.sku,p_idempotency_key||':consume:'||v_component.component_product_id,p_user_id,p_user_name,jsonb_build_object('bomId',v_bom.id,'finishedProductId',v_finished.id));
    if v_before-v_needed<0 then v_shortages:=v_shortages||jsonb_build_array(jsonb_build_object('sku',v_component.sku,'shortage',abs(v_before-v_needed))); end if;
  end loop;
  insert into public.inventory_balances(product_id,location_id,quantity,allocated_quantity) values(v_finished.id,p_location_id,0,0) on conflict(product_id,location_id) do nothing;
  select quantity into v_before from public.inventory_balances where product_id=v_finished.id and location_id=p_location_id for update;
  v_on_hand:=v_before+p_output_quantity;
  update public.inventory_balances set quantity=v_on_hand,updated_at=now() where product_id=v_finished.id and location_id=p_location_id;
  insert into public.inventory_movements(product_id,location_id,movement_type,quantity_delta,quantity_before,quantity_after,reference_type,reference_id,reason,idempotency_key,performed_by_user_id,performed_by_name,metadata)
    values(v_finished.id,p_location_id,'production_complete',p_output_quantity,v_before,v_on_hand,'production',nullif(trim(p_reference),''),'Production complete',p_idempotency_key||':complete',p_user_id,p_user_name,jsonb_build_object('bomId',v_bom.id,'componentsConsumed',true,'shortages',v_shortages));
  insert into public.activity_events(user_id,user_name,action_type,document_type,document_number,description,status,metadata)
    values(p_user_id,coalesce(nullif(trim(p_user_name),''),'Warehouse user'),'PRODUCTION_COMPLETED','production',coalesce(nullif(trim(p_reference),''),'PROD-'||p_idempotency_key),'Completed '||p_output_quantity||' of '||v_finished.sku,'completed',jsonb_build_object('bomId',v_bom.id,'locationId',p_location_id,'quantity',p_output_quantity,'shortages',v_shortages));
  return jsonb_build_object('alreadyCompleted',false,'sku',v_finished.sku,'quantity',p_output_quantity,'onHand',v_on_hand,'shortages',v_shortages);
end $$;
revoke all on function public.complete_v2_production(bigint,bigint,numeric,text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.complete_v2_production(bigint,bigint,numeric,text,text,bigint,text) to service_role;
