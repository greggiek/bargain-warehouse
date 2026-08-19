-- Posts an auditable V2-only receipt into a managed warehouse location.
create or replace function public.receive_v2_inventory(
  p_product_id bigint,
  p_location_id bigint,
  p_quantity numeric,
  p_reference text,
  p_note text,
  p_idempotency_key text,
  p_user_id bigint,
  p_user_name text
)
returns jsonb
language plpgsql
security invoker
set search_path = 'pg_catalog', 'public'
as $$
declare
  v_product public.products%rowtype;
  v_before numeric;
  v_after numeric;
  v_existing public.inventory_movements%rowtype;
  v_reference text := nullif(btrim(coalesce(p_reference, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_quantity is null or p_quantity <= 0 then raise exception 'Received quantity must be greater than zero'; end if;
  if nullif(btrim(coalesce(p_idempotency_key, '')), '') is null then raise exception 'Receipt key is required'; end if;
  select * into v_existing from public.inventory_movements where idempotency_key = p_idempotency_key limit 1;
  if found then return jsonb_build_object('alreadyReceived',true,'productId',v_existing.product_id,'locationId',v_existing.location_id,'quantity',v_existing.quantity_delta,'onHand',v_existing.quantity_after); end if;
  select * into v_product from public.products where id = p_product_id and active = true;
  if not found then raise exception 'Active V2 product not found'; end if;
  insert into public.inventory_balances(product_id,location_id,quantity,allocated_quantity,updated_at) values(p_product_id,p_location_id,0,0,now()) on conflict(product_id,location_id) do nothing;
  select quantity into v_before from public.inventory_balances where product_id=p_product_id and location_id=p_location_id for update;
  update public.inventory_balances set quantity=quantity+p_quantity,updated_at=now() where product_id=p_product_id and location_id=p_location_id returning quantity into v_after;
  insert into public.inventory_movements(product_id,location_id,movement_type,quantity_delta,quantity_before,quantity_after,reference_type,reference_id,reason,idempotency_key,performed_by_user_id,performed_by_name,metadata)
    values(p_product_id,p_location_id,'purchase_receipt',p_quantity,v_before,v_after,'receipt',v_reference,coalesce(v_note,'V2 receiving'),p_idempotency_key,p_user_id,p_user_name,jsonb_build_object('reference',v_reference,'note',v_note));
  insert into public.activity_events(user_id,user_name,action_type,document_type,document_number,description,status,metadata)
    values(p_user_id,p_user_name,'INVENTORY_RECEIVED','receipt',v_reference,'Received '||p_quantity||' of '||v_product.sku||' into V2 inventory','success',jsonb_build_object('productId',p_product_id,'locationId',p_location_id,'sku',v_product.sku,'quantity',p_quantity,'reference',v_reference,'note',v_note));
  return jsonb_build_object('alreadyReceived',false,'productId',p_product_id,'sku',v_product.sku,'quantity',p_quantity,'onHand',v_after);
end $$;
revoke execute on function public.receive_v2_inventory(bigint,bigint,numeric,text,text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.receive_v2_inventory(bigint,bigint,numeric,text,text,text,bigint,text) to service_role;
