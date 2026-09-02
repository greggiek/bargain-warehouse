-- Phase 2.1: durable handoff from completed Manufacturing into the supported
-- Shopify-native transfer workflow. Backend only; feature flag remains disabled.
begin;

alter table public.mfg_planned_transfers
  add column shopify_transfer_link_id uuid unique references public.shopify_transfer_links(id) on delete restrict;

alter table public.shopify_transfer_links
  add column manufacturing_handoff_id bigint unique;

create table public.mfg_transfer_handoffs(
 id bigint generated always as identity primary key,
 work_order_id bigint not null unique references public.mfg_work_orders(id) on delete restrict,
 work_order_number text not null,
 source_location_id bigint not null references public.locations(id) on delete restrict,
 destination_location_id bigint not null references public.locations(id) on delete restrict,
 source_store_key text,
 destination_store_key text,
 source_shopify_location_id text,
 destination_shopify_location_id text,
 idempotency_key text not null unique,
 status text not null default 'pending_inventory_confirmation' check(status in(
  'pending_inventory_confirmation','ready','processing','created','retryable_error',
  'blocked_mapping','permanent_error','cancelled')),
 attempt_count integer not null default 0 check(attempt_count>=0),
 lease_token uuid,lease_expires_at timestamptz,
 last_error text,next_retry_at timestamptz,
 shopify_transfer_link_id uuid unique references public.shopify_transfer_links(id) on delete restrict,
 shopify_transfer_id text,
 created_by bigint not null references public.app_users(id) on delete restrict,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),completed_at timestamptz,
 cancelled_at timestamptz,cancelled_by bigint references public.app_users(id),cancellation_reason text
);
alter table public.shopify_transfer_links
  add constraint shopify_transfer_links_manufacturing_handoff_fkey
  foreign key(manufacturing_handoff_id) references public.mfg_transfer_handoffs(id) on delete restrict;

create table public.mfg_transfer_handoff_lines(
 id bigint generated always as identity primary key,
 handoff_id bigint not null references public.mfg_transfer_handoffs(id) on delete restrict,
 work_order_line_id bigint not null references public.mfg_work_order_lines(id) on delete restrict,
 product_id bigint not null references public.products(id) on delete restrict,
 sku text not null,good_quantity numeric not null check(good_quantity>0),
 source_shopify_variant_id text,source_shopify_inventory_item_id text,
 destination_shopify_variant_id text,destination_shopify_inventory_item_id text,
 created_at timestamptz not null default now(),unique(handoff_id,product_id)
);
create table public.mfg_transfer_handoff_inventory_adjustments(
 id bigint generated always as identity primary key,
 handoff_line_id bigint not null references public.mfg_transfer_handoff_lines(id) on delete restrict,
 finished_inventory_movement_id bigint not null unique references public.inventory_movements(id) on delete restrict,
 outbound_inventory_adjustment_id bigint not null unique references public.mfg_shopify_inventory_adjustments(id) on delete restrict,
 created_at timestamptz not null default now()
);
create index mfg_transfer_handoffs_worker_idx on public.mfg_transfer_handoffs(status,next_retry_at,created_at);
create index mfg_transfer_handoff_lines_handoff_idx on public.mfg_transfer_handoff_lines(handoff_id);
alter table public.mfg_transfer_handoffs enable row level security;
alter table public.mfg_transfer_handoff_lines enable row level security;
alter table public.mfg_transfer_handoff_inventory_adjustments enable row level security;
revoke all on public.mfg_transfer_handoffs,public.mfg_transfer_handoff_lines,public.mfg_transfer_handoff_inventory_adjustments from public,anon,authenticated;
grant select,insert,update on public.mfg_transfer_handoffs,public.mfg_transfer_handoff_lines,public.mfg_transfer_handoff_inventory_adjustments to service_role;

create or replace function public.mfg_handoff_transition_allowed(p_from text,p_to text)
returns boolean language sql immutable set search_path='pg_catalog','public' as $$
 select (p_from,p_to) in(
  ('pending_inventory_confirmation','ready'),('pending_inventory_confirmation','blocked_mapping'),
  ('ready','processing'),('processing','created'),('processing','retryable_error'),
  ('processing','blocked_mapping'),('processing','permanent_error'),('processing','ready'),
  ('retryable_error','processing'),('retryable_error','ready'),('retryable_error','blocked_mapping'),
  ('retryable_error','pending_inventory_confirmation'),
  ('blocked_mapping','pending_inventory_confirmation'),('blocked_mapping','ready'),
  ('pending_inventory_confirmation','cancelled'),('ready','cancelled'),('retryable_error','cancelled'),
  ('blocked_mapping','cancelled'),('permanent_error','cancelled')
 )
$$;

create or replace function public.guard_mfg_transfer_handoff_transition()
returns trigger language plpgsql set search_path='pg_catalog','public' as $$
begin
 if old.status<>new.status and not public.mfg_handoff_transition_allowed(old.status,new.status)
 then raise exception 'invalid_manufacturing_handoff_transition:%:%',old.status,new.status;end if;
 return new;
end $$;
create trigger guard_mfg_transfer_handoff_transition before update of status on public.mfg_transfer_handoffs
for each row execute function public.guard_mfg_transfer_handoff_transition();

create or replace function public.refresh_mfg_transfer_handoff(p_handoff_id bigint)
returns text language plpgsql security definer set search_path='pg_catalog','public' as $$
declare h public.mfg_transfer_handoffs%rowtype;v_error text;
begin
 select * into h from public.mfg_transfer_handoffs where id=p_handoff_id for update;
 if not found then raise exception 'manufacturing_handoff_not_found';end if;
 if h.status in('created','cancelled','permanent_error','processing') then return h.status;end if;
 -- Re-resolve mutable route/source mappings so a corrected mapping safely unblocks
 -- the immutable quantity handoff without rebuilding Manufacturing history.
 update public.mfg_transfer_handoffs x set
  source_store_key=src.store_key,source_shopify_location_id=src.shopify_location_id,
  destination_store_key=dst.store_key,destination_shopify_location_id=dst.shopify_location_id,updated_at=now()
 from public.shopify_location_mappings src,public.shopify_location_mappings dst
 where x.id=h.id and src.location_id=x.source_location_id and dst.location_id=x.destination_location_id;
 update public.mfg_transfer_handoff_lines l set
  source_shopify_variant_id=(select s.shopify_variant_id from public.product_shopify_sources s where s.product_id=l.product_id and s.store_key=h.source_store_key),
  source_shopify_inventory_item_id=(select s.shopify_inventory_item_id from public.product_shopify_sources s where s.product_id=l.product_id and s.store_key=h.source_store_key),
  destination_shopify_variant_id=(select s.shopify_variant_id from public.product_shopify_sources s where s.product_id=l.product_id and s.store_key=h.destination_store_key),
  destination_shopify_inventory_item_id=(select s.shopify_inventory_item_id from public.product_shopify_sources s where s.product_id=l.product_id and s.store_key=h.destination_store_key)
 where l.handoff_id=h.id;
 select * into h from public.mfg_transfer_handoffs where id=p_handoff_id;
 if h.source_store_key is null or h.destination_store_key is null or h.source_store_key<>h.destination_store_key
    or h.source_shopify_location_id is null or h.destination_shopify_location_id is null then
   v_error:='Shopify-native same-store route mapping is incomplete or unsupported.';
 elsif exists(select 1 from public.mfg_transfer_handoff_lines l where l.handoff_id=h.id and
   (l.source_shopify_variant_id is null or l.source_shopify_inventory_item_id is null or l.destination_shopify_variant_id is null)) then
   select 'Missing Shopify mapping for SKU '||string_agg(sku,', ' order by sku) into v_error
   from public.mfg_transfer_handoff_lines where handoff_id=h.id and
    (source_shopify_variant_id is null or source_shopify_inventory_item_id is null or destination_shopify_variant_id is null);
 end if;
 if v_error is not null then
   update public.mfg_transfer_handoffs set status='blocked_mapping',last_error=v_error,updated_at=now() where id=h.id;
   return 'blocked_mapping';
 end if;
 if exists(select 1 from public.mfg_transfer_handoff_lines l
   left join public.mfg_transfer_handoff_inventory_adjustments ha on ha.handoff_line_id=l.id
   left join public.mfg_shopify_inventory_adjustments a on a.id=ha.outbound_inventory_adjustment_id
   where l.handoff_id=h.id and(a.id is null or a.status<>'confirmed' or a.shopify_adjustment_id is null))
 or exists(select 1 from public.mfg_transfer_handoff_lines l where l.handoff_id=h.id and not exists(
   select 1 from public.mfg_transfer_handoff_inventory_adjustments ha
   join public.mfg_shopify_inventory_adjustments a on a.id=ha.outbound_inventory_adjustment_id
   join public.shopify_inventory_cache c on c.store_key=h.source_store_key
    and c.shopify_location_id=h.source_shopify_location_id
    and c.shopify_inventory_item_id=l.source_shopify_inventory_item_id
    and c.on_hand_quantity=a.expected_shopify_on_hand
   where ha.handoff_line_id=l.id
     and a.id=(select max(a2.id) from public.mfg_transfer_handoff_inventory_adjustments ha2
       join public.mfg_shopify_inventory_adjustments a2 on a2.id=ha2.outbound_inventory_adjustment_id
       where ha2.handoff_line_id=l.id))) then
   if h.status<>'pending_inventory_confirmation' then
    update public.mfg_transfer_handoffs set status='pending_inventory_confirmation',last_error=null,updated_at=now() where id=h.id;
   end if;
   return 'pending_inventory_confirmation';
 end if;
 update public.mfg_transfer_handoffs set status='ready',last_error=null,next_retry_at=null,updated_at=now() where id=h.id;
 return 'ready';
end $$;

create or replace function public.claim_mfg_transfer_handoff(p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path='pg_catalog','public' as $$
declare h public.mfg_transfer_handoffs%rowtype;t uuid:=gen_random_uuid();
begin
 for h in select * from public.mfg_transfer_handoffs where status in('pending_inventory_confirmation','blocked_mapping')
   order by id for update skip locked loop perform public.refresh_mfg_transfer_handoff(h.id);end loop;
 select * into h from public.mfg_transfer_handoffs where
  (status='ready' or(status='retryable_error' and coalesce(next_retry_at,now())<=now())
   or(status='processing' and lease_expires_at<now()))
  order by id for update skip locked limit 1;
 if not found then return null;end if;
 update public.mfg_transfer_handoffs set status=case when h.status='processing' then 'ready' else status end where id=h.id;
 update public.mfg_transfer_handoffs set status='processing',attempt_count=attempt_count+1,lease_token=t,
  lease_expires_at=now()+make_interval(secs=>greatest(p_lease_seconds,15)),last_error=null,updated_at=now() where id=h.id;
 return jsonb_build_object('id',h.id,'workOrderId',h.work_order_id,'workOrderNumber',h.work_order_number,
  'sourceLocationId',h.source_location_id,'destinationLocationId',h.destination_location_id,
  'storeKey',h.source_store_key,'sourceShopifyLocationId',h.source_shopify_location_id,
  'destinationShopifyLocationId',h.destination_shopify_location_id,'idempotencyKey',h.idempotency_key,
  'leaseToken',t,'attempt',h.attempt_count+1);
end $$;

create or replace function public.begin_mfg_transfer_handoff_link(p_handoff_id bigint,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path='pg_catalog','public' as $$
declare h public.mfg_transfer_handoffs%rowtype;l public.shopify_transfer_links%rowtype;
begin
 select * into h from public.mfg_transfer_handoffs where id=p_handoff_id and status='processing'
  and lease_token=p_lease_token and lease_expires_at>now() for update;
 if not found then raise exception 'manufacturing_handoff_lease_lost';end if;
 select * into l from public.shopify_transfer_links where manufacturing_handoff_id=h.id for update;
 if not found then
  insert into public.shopify_transfer_links(bm_reference,route_type,status,source_location_id,destination_location_id,
   source_store_key,destination_store_key,source_shopify_location_id,destination_shopify_location_id,
   created_by_user_id,created_by_name,manufacturing_handoff_id,metadata)
  values('MFG-'||h.work_order_number,'same_store','draft',h.source_location_id,h.destination_location_id,
   h.source_store_key,h.destination_store_key,h.source_shopify_location_id,h.destination_shopify_location_id,
   null,'Manufacturing transfer worker',h.id,jsonb_build_object('created_from','manufacturing','work_order_id',h.work_order_id,
    'handoff_id',h.id,'inventory_effect','none'))
  returning * into l;
  insert into public.shopify_transfer_link_lines(transfer_link_id,sku,product_id,quantity,source_shopify_variant_id,destination_shopify_variant_id)
   select l.id,x.sku,x.product_id,x.good_quantity,x.source_shopify_variant_id,x.destination_shopify_variant_id
   from public.mfg_transfer_handoff_lines x where x.handoff_id=h.id;
 end if;
 update public.mfg_transfer_handoffs set shopify_transfer_link_id=l.id,updated_at=now() where id=h.id;
 return jsonb_build_object('linkId',l.id,'bmReference',l.bm_reference,'existingShopifyTransferId',l.source_shopify_transfer_id,
  'lines',(select jsonb_agg(jsonb_build_object('sku',x.sku,'quantity',x.good_quantity,
   'inventoryItemId',x.source_shopify_inventory_item_id) order by x.id) from public.mfg_transfer_handoff_lines x where x.handoff_id=h.id));
end $$;

create or replace function public.finish_mfg_transfer_handoff(p_handoff_id bigint,p_lease_token uuid,p_shopify_transfer_id text,p_shopify_name text)
returns jsonb language plpgsql security definer set search_path='pg_catalog','public' as $$
declare h public.mfg_transfer_handoffs%rowtype;r jsonb;
begin
 select * into h from public.mfg_transfer_handoffs where id=p_handoff_id and status='processing' and lease_token=p_lease_token for update;
 if not found then raise exception 'manufacturing_handoff_lease_lost';end if;
 if nullif(btrim(coalesce(p_shopify_transfer_id,'')),'') is null then raise exception 'shopify_transfer_id_required';end if;
 update public.shopify_transfer_links set source_shopify_transfer_id=p_shopify_transfer_id,status='draft',error=null,
  metadata=metadata||jsonb_build_object('shopify_transfer_name',p_shopify_name,'manufacturing_handoff_id',h.id)
  where id=h.shopify_transfer_link_id and manufacturing_handoff_id=h.id;
 if not found then raise exception 'manufacturing_transfer_link_missing';end if;
 update public.mfg_planned_transfers set status='promoted',shopify_transfer_link_id=h.shopify_transfer_link_id,updated_at=now()
  where work_order_id=h.work_order_id;
 update public.mfg_transfer_handoffs set status='created',shopify_transfer_id=p_shopify_transfer_id,
  completed_at=now(),lease_token=null,lease_expires_at=null,last_error=null,updated_at=now() where id=h.id;
 r:=jsonb_build_object('handoffId',h.id,'shopifyTransferLinkId',h.shopify_transfer_link_id,
  'shopifyTransferId',p_shopify_transfer_id,'status','created');
 insert into public.mfg_audit_events(work_order_id,event_type,actor_user_id,idempotency_key,details)
 values(h.work_order_id,'shopify_native_transfer_created',h.created_by,h.idempotency_key||':created-audit',r);
 return r;
end $$;

create or replace function public.fail_mfg_transfer_handoff(p_handoff_id bigint,p_lease_token uuid,p_error text,p_permanent boolean default false)
returns void language plpgsql security definer set search_path='pg_catalog','public' as $$
begin
 update public.mfg_transfer_handoffs set status=case when p_permanent then 'permanent_error' else 'retryable_error' end,
  last_error=left(coalesce(p_error,'unknown error'),2000),
  next_retry_at=case when p_permanent then null else now()+least(interval '1 hour',interval '15 seconds'*power(2,least(attempt_count,8))) end,
  lease_token=null,lease_expires_at=null,updated_at=now()
 where id=p_handoff_id and status='processing' and lease_token=p_lease_token;
 if not found then raise exception 'manufacturing_handoff_lease_lost';end if;
end $$;

-- Replace Phase 2 completion: promote the planned quantity into one durable handoff,
-- never into the retired public.transfers workflow.
create or replace function public.complete_mfg_work_order(p_actor_user_id bigint,p_work_order_id bigint,p_idempotency_key text)
returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare w public.mfg_work_orders%rowtype;p public.mfg_planned_transfers%rowtype;h public.mfg_transfer_handoffs%rowtype;
 s record;d record;r jsonb;
begin
 if not public.mfg_actor_can(p_actor_user_id,'manufacturing_complete') then raise exception 'manufacturing_permission_denied:manufacturing_complete';end if;
 select * into w from public.mfg_work_orders where id=p_work_order_id for update;if not found then raise exception 'work_order_not_found';end if;
 if not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=w.production_location_id and can_manage)
 or not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=w.destination_location_id and can_manage)
 then raise exception 'manufacturing_location_permission_denied';end if;
 select details into r from public.mfg_audit_events where work_order_id=w.id and idempotency_key=p_idempotency_key||':audit';if found then return r;end if;
 if w.status not in('In Production','Partially Completed') then raise exception 'work_order_not_ready_to_complete:%',w.status;end if;
 if exists(select 1 from public.mfg_work_order_lines where work_order_id=w.id and(remaining_quantity<>0 or rejected_quantity<>0 or rework_quantity<>0))
 then raise exception 'all_units_and_dispositions_must_be_resolved';end if;
 if exists(select 1 from public.mfg_work_order_lines l left join public.mfg_planned_transfers pt on pt.work_order_id=l.work_order_id
  left join public.mfg_planned_transfer_lines pl on pl.planned_transfer_id=pt.id and pl.product_id=l.finished_product_id
  where l.work_order_id=w.id and coalesce(pl.transferable_quantity,-1)<>l.good_quantity) then raise exception 'planned_transfer_does_not_equal_good_production';end if;
 select * into p from public.mfg_planned_transfers where work_order_id=w.id for update;
 if not found or p.status<>'planned' then raise exception 'planned_transfer_not_promotable';end if;
 select m.store_key,m.shopify_location_id into s from public.shopify_location_mappings m where m.location_id=w.production_location_id;
 select m.store_key,m.shopify_location_id into d from public.shopify_location_mappings m where m.location_id=w.destination_location_id;
 insert into public.mfg_transfer_handoffs(work_order_id,work_order_number,source_location_id,destination_location_id,
  source_store_key,destination_store_key,source_shopify_location_id,destination_shopify_location_id,
  idempotency_key,created_by)
 values(w.id,w.work_order_number,w.production_location_id,w.destination_location_id,s.store_key,d.store_key,
  s.shopify_location_id,d.shopify_location_id,p_idempotency_key||':shopify-native-transfer',p_actor_user_id) returning * into h;
 insert into public.mfg_transfer_handoff_lines(handoff_id,work_order_line_id,product_id,sku,good_quantity,source_shopify_variant_id,
  source_shopify_inventory_item_id,destination_shopify_variant_id,destination_shopify_inventory_item_id)
 select h.id,l.id,l.finished_product_id,pr.sku,l.good_quantity,
  src.shopify_variant_id,src.shopify_inventory_item_id,dst.shopify_variant_id,dst.shopify_inventory_item_id
 from public.mfg_work_order_lines l join public.products pr on pr.id=l.finished_product_id
 left join public.product_shopify_sources src on src.product_id=l.finished_product_id and src.store_key=s.store_key
 left join public.product_shopify_sources dst on dst.product_id=l.finished_product_id and dst.store_key=d.store_key
 where l.work_order_id=w.id and l.good_quantity>0;
 if (select count(*) from public.mfg_transfer_handoff_lines where handoff_id=h.id)<>
    (select count(*) from public.mfg_work_order_lines where work_order_id=w.id and good_quantity>0)
 then raise exception 'manufacturing_handoff_line_reconciliation_failed';end if;
 insert into public.mfg_transfer_handoff_inventory_adjustments(handoff_line_id,finished_inventory_movement_id,outbound_inventory_adjustment_id)
 select hl.id,f.inventory_movement_id,a.id from public.mfg_transfer_handoff_lines hl
 join public.mfg_finished_inventory_events f on f.product_id=hl.product_id
 join public.mfg_completion_events ce on ce.id=f.completion_event_id and ce.work_order_line_id=hl.work_order_line_id
 join public.mfg_shopify_inventory_adjustments a on a.inventory_movement_id=f.inventory_movement_id
 where hl.handoff_id=h.id;
 if exists(select 1 from public.mfg_finished_inventory_events f join public.mfg_completion_events ce on ce.id=f.completion_event_id
   join public.mfg_work_order_lines l on l.id=ce.work_order_line_id
   where l.work_order_id=w.id and not exists(select 1 from public.mfg_transfer_handoff_inventory_adjustments ha where ha.finished_inventory_movement_id=f.inventory_movement_id))
 then raise exception 'manufacturing_finished_adjustment_reconciliation_failed';end if;
 update public.mfg_work_orders set status='Completed',completed_at=now(),updated_at=now() where id=w.id;
 insert into public.mfg_status_history(work_order_id,from_status,to_status,changed_by,idempotency_key)
 values(w.id,w.status,'Completed',p_actor_user_id,p_idempotency_key||':status');
 r:=jsonb_build_object('workOrderId',w.id,'status','Completed','handoffId',h.id,
  'handoffStatus','pending_inventory_confirmation','shopifyCall',false);
 insert into public.mfg_audit_events(work_order_id,event_type,actor_user_id,idempotency_key,details)
 values(w.id,'completed_transfer_handoff_pending',p_actor_user_id,p_idempotency_key||':audit',r);
 return r;
end $$;

create or replace function public.close_mfg_work_order(p_actor_user_id bigint,p_work_order_id bigint,p_idempotency_key text)
returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare w public.mfg_work_orders%rowtype;h public.mfg_transfer_handoffs%rowtype;r jsonb;
begin
 if not public.mfg_actor_can(p_actor_user_id,'manufacturing_close') then raise exception 'manufacturing_permission_denied:manufacturing_close';end if;
 select * into w from public.mfg_work_orders where id=p_work_order_id for update;if not found then raise exception 'work_order_not_found';end if;
 if not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=w.production_location_id and can_manage)
 or not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=w.destination_location_id and can_manage)
 then raise exception 'manufacturing_location_permission_denied';end if;
 select details into r from public.mfg_audit_events where work_order_id=w.id and idempotency_key=p_idempotency_key||':audit';if found then return r;end if;
 if w.status<>'Completed' then raise exception 'only_completed_work_order_can_close';end if;
 select * into h from public.mfg_transfer_handoffs where work_order_id=w.id for update;
 if not found or h.status<>'created' or h.shopify_transfer_link_id is null or h.shopify_transfer_id is null
  or not exists(select 1 from public.shopify_transfer_links sl where sl.id=h.shopify_transfer_link_id
    and sl.manufacturing_handoff_id=h.id and sl.source_shopify_transfer_id=h.shopify_transfer_id)
  or exists(select 1 from public.mfg_transfer_handoff_lines x left join public.shopify_transfer_link_lines sl
    on sl.transfer_link_id=h.shopify_transfer_link_id and sl.product_id=x.product_id and sl.quantity=x.good_quantity
    where x.handoff_id=h.id and sl.id is null)
  or exists(select 1 from public.mfg_transfer_handoff_lines x join public.mfg_transfer_handoff_inventory_adjustments ha on ha.handoff_line_id=x.id
    join public.mfg_shopify_inventory_adjustments a on a.id=ha.outbound_inventory_adjustment_id where x.handoff_id=h.id and a.status<>'confirmed')
 then raise exception 'work_order_transfer_handoff_unresolved';end if;
 update public.mfg_work_orders set status='Closed',closed_at=now(),closed_by=p_actor_user_id,updated_at=now() where id=w.id;
 insert into public.mfg_status_history(work_order_id,from_status,to_status,changed_by,idempotency_key)
 values(w.id,'Completed','Closed',p_actor_user_id,p_idempotency_key||':status');
 r:=jsonb_build_object('workOrderId',w.id,'status','Closed','inventoryEffect',false,'shopifyTransferId',h.shopify_transfer_id);
 insert into public.mfg_audit_events(work_order_id,event_type,actor_user_id,idempotency_key,details)
 values(w.id,'closed',p_actor_user_id,p_idempotency_key||':audit',r);return r;
end $$;

create or replace function public.cancel_mfg_transfer_handoff(p_actor_user_id bigint,p_handoff_id bigint,p_reason text,p_idempotency_key text)
returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare h public.mfg_transfer_handoffs%rowtype;r jsonb;
begin
 if not public.mfg_actor_can(p_actor_user_id,'manufacturing_admin_correction') then raise exception 'manufacturing_permission_denied:manufacturing_admin_correction';end if;
 if nullif(btrim(coalesce(p_reason,'')),'') is null then raise exception 'manufacturing_handoff_cancellation_reason_required';end if;
 select * into h from public.mfg_transfer_handoffs where id=p_handoff_id for update;if not found then raise exception 'manufacturing_handoff_not_found';end if;
 select details into r from public.mfg_audit_events where work_order_id=h.work_order_id and idempotency_key=p_idempotency_key||':audit';if found then return r;end if;
 if h.status in('created','cancelled') or exists(select 1 from public.shopify_transfer_links where manufacturing_handoff_id=h.id and source_shopify_transfer_id is not null)
 then raise exception 'manufacturing_handoff_cannot_cancel_shopify_transfer_exists_or_cancelled';end if;
 update public.mfg_transfer_handoffs set status='cancelled',cancelled_at=now(),cancelled_by=p_actor_user_id,
  cancellation_reason=btrim(p_reason),lease_token=null,lease_expires_at=null,updated_at=now() where id=h.id;
 r:=jsonb_build_object('handoffId',h.id,'status','cancelled','reason',btrim(p_reason),'inventoryEffect',false);
 insert into public.mfg_audit_events(work_order_id,event_type,actor_user_id,idempotency_key,details)
 values(h.work_order_id,'transfer_handoff_cancelled_admin_correction',p_actor_user_id,p_idempotency_key||':audit',r);
 return r;
end $$;

revoke all on function public.refresh_mfg_transfer_handoff(bigint) from public,anon,authenticated;
revoke all on function public.claim_mfg_transfer_handoff(integer) from public,anon,authenticated;
revoke all on function public.begin_mfg_transfer_handoff_link(bigint,uuid) from public,anon,authenticated;
revoke all on function public.finish_mfg_transfer_handoff(bigint,uuid,text,text) from public,anon,authenticated;
revoke all on function public.fail_mfg_transfer_handoff(bigint,uuid,text,boolean) from public,anon,authenticated;
revoke all on function public.cancel_mfg_transfer_handoff(bigint,bigint,text,text) from public,anon,authenticated;
grant execute on function public.refresh_mfg_transfer_handoff(bigint) to service_role;
grant execute on function public.claim_mfg_transfer_handoff(integer) to service_role;
grant execute on function public.begin_mfg_transfer_handoff_link(bigint,uuid) to service_role;
grant execute on function public.finish_mfg_transfer_handoff(bigint,uuid,text,text) to service_role;
grant execute on function public.fail_mfg_transfer_handoff(bigint,uuid,text,boolean) to service_role;
grant execute on function public.cancel_mfg_transfer_handoff(bigint,bigint,text,text) to service_role;

commit;
