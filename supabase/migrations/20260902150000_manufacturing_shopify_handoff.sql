-- Durable post-commit Shopify handoff for Manufacturing inventory movements.
-- The trigger only enqueues; Shopify is called by the backend worker after commit.

begin;

create table public.mfg_shopify_inventory_routes (
  location_id bigint primary key references public.locations(id) on delete restrict,
  store_key text not null check (store_key in ('store_1','store_2')),
  shopify_location_id text not null,
  active boolean not null default true,
  configured_at timestamptz not null default now(),
  unique(store_key,shopify_location_id),
  foreign key(store_key,shopify_location_id)
    references public.shopify_location_mappings(store_key,shopify_location_id) on delete restrict
);

create table public.mfg_shopify_inventory_adjustments (
  id bigint generated always as identity primary key,
  inventory_movement_id bigint not null unique references public.inventory_movements(id) on delete restrict,
  work_order_id bigint not null references public.mfg_work_orders(id) on delete restrict,
  product_id bigint not null references public.products(id) on delete restrict,
  location_id bigint not null references public.locations(id) on delete restrict,
  store_key text not null check (store_key in ('store_1','store_2')),
  shopify_location_id text not null,
  shopify_inventory_item_id text not null,
  quantity_delta numeric(16,4) not null check (quantity_delta<>0),
  expected_shopify_on_hand numeric(16,4),
  idempotency_key text not null unique,
  status text not null default 'pending' check(status in
    ('pending','processing','shopify_confirmed','confirmed','failed')),
  attempts integer not null default 0 check(attempts>=0),
  lease_token uuid,
  lease_expires_at timestamptz,
  shopify_adjustment_id text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  shopify_confirmed_at timestamptz,
  reconciled_at timestamptz
);
create index mfg_shopify_adjustments_work_idx on public.mfg_shopify_inventory_adjustments(status,created_at);
create index mfg_shopify_adjustments_identity_idx on public.mfg_shopify_inventory_adjustments(store_key,shopify_location_id,shopify_inventory_item_id,id);

alter table public.mfg_shopify_inventory_routes enable row level security;
alter table public.mfg_shopify_inventory_adjustments enable row level security;
revoke all on public.mfg_shopify_inventory_routes,public.mfg_shopify_inventory_adjustments from public,anon,authenticated;
grant select,insert,update,delete on public.mfg_shopify_inventory_routes to service_role;
grant select,insert,update on public.mfg_shopify_inventory_adjustments to service_role;

create or replace function public.enqueue_mfg_shopify_inventory_adjustment()
returns trigger language plpgsql security definer set search_path='pg_catalog','public' as $$
declare v_route public.mfg_shopify_inventory_routes%rowtype; v_item text; v_count integer;
begin
  if new.reference_type<>'manufacturing' or coalesce(new.metadata->>'source','')<>'manufacturing' then return new; end if;
  select * into v_route from public.mfg_shopify_inventory_routes where location_id=new.location_id and active for share;
  if not found then raise exception 'manufacturing_shopify_route_missing:%',new.location_id; end if;
  select count(*),min(ps.shopify_inventory_item_id) into v_count,v_item
  from public.product_shopify_sources ps
  where ps.product_id=new.product_id and ps.store_key=v_route.store_key
    and nullif(btrim(ps.shopify_inventory_item_id),'') is not null;
  if v_count<>1 then raise exception 'manufacturing_shopify_inventory_mapping_not_unique:%:%',new.product_id,v_route.store_key; end if;
  if not exists(select 1 from public.shopify_inventory_cache c where c.store_key=v_route.store_key
    and c.shopify_location_id=v_route.shopify_location_id and c.shopify_inventory_item_id=v_item)
  then raise exception 'manufacturing_shopify_cache_snapshot_missing:%:%',new.product_id,v_route.store_key; end if;
  insert into public.mfg_shopify_inventory_adjustments(
    inventory_movement_id,work_order_id,product_id,location_id,store_key,shopify_location_id,
    shopify_inventory_item_id,quantity_delta,idempotency_key)
  values(new.id,new.reference_id::bigint,new.product_id,new.location_id,v_route.store_key,
    v_route.shopify_location_id,v_item,new.quantity_delta,new.idempotency_key||':shopify')
  on conflict(inventory_movement_id) do nothing;
  return new;
end $$;

create trigger enqueue_mfg_shopify_inventory_adjustment
after insert on public.inventory_movements for each row
execute function public.enqueue_mfg_shopify_inventory_adjustment();

create or replace function public.claim_mfg_shopify_inventory_adjustment(p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path='pg_catalog','public' as $$
declare v_row public.mfg_shopify_inventory_adjustments%rowtype; v_token uuid:=gen_random_uuid();
begin
  select q.* into v_row from public.mfg_shopify_inventory_adjustments q
  where (q.status in ('pending','failed') or (q.status='processing' and q.lease_expires_at<now()))
    and not exists(select 1 from public.mfg_shopify_inventory_adjustments prior
      where prior.store_key=q.store_key and prior.shopify_location_id=q.shopify_location_id
        and prior.shopify_inventory_item_id=q.shopify_inventory_item_id and prior.id<q.id
        and prior.status<>'confirmed')
  order by q.id for update skip locked limit 1;
  if not found then return null; end if;
  update public.mfg_shopify_inventory_adjustments set status='processing',attempts=attempts+1,
    lease_token=v_token,lease_expires_at=now()+make_interval(secs=>greatest(p_lease_seconds,15)),updated_at=now()
  where id=v_row.id;
  return jsonb_build_object('id',v_row.id,'storeKey',v_row.store_key,'shopifyLocationId',v_row.shopify_location_id,
    'shopifyInventoryItemId',v_row.shopify_inventory_item_id,'quantityDelta',v_row.quantity_delta,
    'idempotencyKey',v_row.idempotency_key,'leaseToken',v_token,'attempt',v_row.attempts+1);
end $$;

create or replace function public.prepare_mfg_shopify_inventory_adjustment(
  p_id bigint,p_lease_token uuid,p_current_on_hand numeric)
returns numeric language plpgsql security definer set search_path='pg_catalog','public' as $$
declare v_expected numeric;
begin
  update public.mfg_shopify_inventory_adjustments
    set expected_shopify_on_hand=p_current_on_hand+quantity_delta,updated_at=now()
  where id=p_id and status='processing' and lease_token=p_lease_token and lease_expires_at>now()
  returning expected_shopify_on_hand into v_expected;
  if not found then raise exception 'manufacturing_shopify_lease_lost'; end if;
  return v_expected;
end $$;

create or replace function public.confirm_mfg_shopify_inventory_adjustment(
  p_id bigint,p_lease_token uuid,p_shopify_adjustment_id text)
returns void language plpgsql security definer set search_path='pg_catalog','public' as $$
begin
  update public.mfg_shopify_inventory_adjustments set status='shopify_confirmed',
    shopify_adjustment_id=p_shopify_adjustment_id,shopify_confirmed_at=now(),last_error=null,
    lease_token=null,lease_expires_at=null,updated_at=now()
  where id=p_id and status='processing' and lease_token=p_lease_token;
  if not found then raise exception 'manufacturing_shopify_lease_lost'; end if;
end $$;

create or replace function public.fail_mfg_shopify_inventory_adjustment(
  p_id bigint,p_lease_token uuid,p_error text)
returns void language plpgsql security definer set search_path='pg_catalog','public' as $$
begin
  update public.mfg_shopify_inventory_adjustments set status='failed',last_error=left(coalesce(p_error,'unknown error'),2000),
    lease_token=null,lease_expires_at=null,updated_at=now()
  where id=p_id and status='processing' and lease_token=p_lease_token;
  if not found then raise exception 'manufacturing_shopify_lease_lost'; end if;
end $$;

-- Reconciliation consumes raw signed Shopify data, confirms reflected queue entries,
-- then overlays only still-unreflected Manufacturing deltas on the operational balance.
create or replace function public.apply_v2_shopify_inventory_sync_page(p_store_key text,p_cycle_key text,p_items jsonb)
returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare v_item jsonb;v_level jsonb;v_sku text;v_item_id text;v_product_id bigint;v_product_count integer;
 v_location_id bigint;v_on_hand numeric;v_available numeric;v_committed numeric;v_before numeric;v_before_allocated numeric;
 v_pending numeric;v_match bigint;v_operational numeric;v_applied integer:=0;v_changed integer:=0;v_skipped integer:=0;
begin
 if p_store_key not in('store_1','store_2') then raise exception 'Unknown Shopify store.';end if;
 if nullif(btrim(coalesce(p_cycle_key,'')),'') is null then raise exception 'Sync cycle key is required.';end if;
 for v_item in select value from jsonb_array_elements(coalesce(p_items,'[]'::jsonb)) loop
  v_sku:=nullif(btrim(coalesce(v_item->>'sku','')),'');v_item_id:=nullif(btrim(coalesce(v_item->>'inventoryItemId','')),'');
  if v_sku is null or v_item_id is null then v_skipped:=v_skipped+1;continue;end if;
  select count(*),min(id) into v_product_count,v_product_id from public.products where active and upper(btrim(sku))=upper(v_sku);
  if v_product_count<>1 then v_skipped:=v_skipped+1;continue;end if;
  for v_level in select value from jsonb_array_elements(coalesce(v_item->'levels','[]'::jsonb)) loop
   select location_id into v_location_id from public.shopify_location_mappings where store_key=p_store_key and shopify_location_id=coalesce(v_level->>'locationId','') limit 1;
   if v_location_id is null then continue;end if;
   v_on_hand:=coalesce(nullif(v_level->>'onHand','')::numeric,0);v_available:=coalesce(nullif(v_level->>'available','')::numeric,0);
   v_committed:=coalesce(nullif(v_level->>'committed','')::numeric,v_on_hand-v_available);
   if v_committed<0 then raise exception 'Shopify committed quantity cannot be negative for %.',v_sku;end if;
   select max(id) into v_match from public.mfg_shopify_inventory_adjustments where store_key=p_store_key
    and shopify_location_id=v_level->>'locationId' and shopify_inventory_item_id=v_item_id
    and status='shopify_confirmed' and expected_shopify_on_hand=v_on_hand;
   if v_match is not null then
    update public.mfg_shopify_inventory_adjustments set status='confirmed',reconciled_at=now(),updated_at=now()
    where store_key=p_store_key and shopify_location_id=v_level->>'locationId' and shopify_inventory_item_id=v_item_id
      and id<=v_match and status='shopify_confirmed';
   end if;
   select coalesce(sum(quantity_delta),0) into v_pending from public.mfg_shopify_inventory_adjustments
    where store_key=p_store_key and shopify_location_id=v_level->>'locationId' and shopify_inventory_item_id=v_item_id
      and status in('pending','processing','shopify_confirmed','failed');
   v_operational:=v_on_hand+v_pending;
   insert into public.inventory_balances(product_id,location_id,quantity,allocated_quantity) values(v_product_id,v_location_id,0,0) on conflict do nothing;
   select quantity,allocated_quantity into v_before,v_before_allocated from public.inventory_balances where product_id=v_product_id and location_id=v_location_id for update;
   update public.inventory_balances set quantity=v_operational,allocated_quantity=v_committed,updated_at=now() where product_id=v_product_id and location_id=v_location_id;
   v_applied:=v_applied+1;if v_before is distinct from v_operational then
    insert into public.inventory_movements(product_id,location_id,movement_type,quantity_delta,quantity_before,quantity_after,reference_type,reference_id,reason,idempotency_key,performed_by_name,metadata)
    values(v_product_id,v_location_id,'shopify_reconciliation',v_operational-v_before,v_before,v_operational,'shopify_inventory_sync',v_item_id,
      'Shopify reconciliation with pending Manufacturing overlay','shopify-sync:'||p_store_key||':'||p_cycle_key||':'||v_item_id||':'||coalesce(v_level->>'locationId',''),
      'Shopify sync',jsonb_build_object('source','shopify_reconciliation','outboundShopify',false,'shopifyOnHand',v_on_hand,'pendingManufacturingDelta',v_pending,'operationalOnHand',v_operational));
   end if;
   if v_before is distinct from v_operational or v_before_allocated is distinct from v_committed then v_changed:=v_changed+1;end if;
  end loop;
 end loop;
 return jsonb_build_object('appliedLevels',v_applied,'changedLevels',v_changed,'skippedItems',v_skipped);
end $$;

revoke all on function public.claim_mfg_shopify_inventory_adjustment(integer) from public,anon,authenticated;
revoke all on function public.prepare_mfg_shopify_inventory_adjustment(bigint,uuid,numeric) from public,anon,authenticated;
revoke all on function public.confirm_mfg_shopify_inventory_adjustment(bigint,uuid,text) from public,anon,authenticated;
revoke all on function public.fail_mfg_shopify_inventory_adjustment(bigint,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_mfg_shopify_inventory_adjustment(integer) to service_role;
grant execute on function public.prepare_mfg_shopify_inventory_adjustment(bigint,uuid,numeric) to service_role;
grant execute on function public.confirm_mfg_shopify_inventory_adjustment(bigint,uuid,text) to service_role;
grant execute on function public.fail_mfg_shopify_inventory_adjustment(bigint,uuid,text) to service_role;

commit;
