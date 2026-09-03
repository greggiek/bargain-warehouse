-- BM-MFG-PILOT-001 worker isolation. Additive and disabled by default.
begin;

alter table public.manufacturing_pilot_gate
  add column approved_work_order_id bigint unique references public.mfg_work_orders(id) on delete restrict;

insert into public.mfg_feature_flags(flag_key,enabled,notes,updated_at) values
 ('manufacturing_pilot_release_enabled',false,'Explicit pilot activation required',now()),
 ('manufacturing_pilot_completion_enabled',false,'Explicit pilot activation required',now()),
 ('manufacturing_pilot_inventory_enabled',false,'Explicit pilot activation required',now()),
 ('manufacturing_pilot_outbound_enabled',false,'Explicit pilot activation required',now()),
 ('manufacturing_pilot_transfer_enabled',false,'Explicit pilot activation required',now())
on conflict(flag_key) do update set enabled=false,notes=excluded.notes,updated_at=now();

alter table public.mfg_work_orders add column pilot_identifier text references public.manufacturing_pilot_gate(pilot_identifier) on delete restrict;
alter table public.mfg_work_orders add column pilot_work_order_id bigint references public.mfg_work_orders(id) on delete restrict;
alter table public.mfg_component_allocations add column pilot_identifier text references public.manufacturing_pilot_gate(pilot_identifier) on delete restrict;
alter table public.mfg_component_allocations add column pilot_work_order_id bigint references public.mfg_work_orders(id) on delete restrict;
alter table public.mfg_completion_events add column pilot_identifier text references public.manufacturing_pilot_gate(pilot_identifier) on delete restrict;
alter table public.mfg_completion_events add column pilot_work_order_id bigint references public.mfg_work_orders(id) on delete restrict;
alter table public.mfg_component_consumption_events add column pilot_identifier text references public.manufacturing_pilot_gate(pilot_identifier) on delete restrict;
alter table public.mfg_component_consumption_events add column pilot_work_order_id bigint references public.mfg_work_orders(id) on delete restrict;
alter table public.mfg_finished_inventory_events add column pilot_identifier text references public.manufacturing_pilot_gate(pilot_identifier) on delete restrict;
alter table public.mfg_finished_inventory_events add column pilot_work_order_id bigint references public.mfg_work_orders(id) on delete restrict;
alter table public.inventory_movements add column pilot_identifier text references public.manufacturing_pilot_gate(pilot_identifier) on delete restrict;
alter table public.inventory_movements add column pilot_work_order_id bigint references public.mfg_work_orders(id) on delete restrict;
alter table public.mfg_shopify_inventory_adjustments add column pilot_identifier text references public.manufacturing_pilot_gate(pilot_identifier) on delete restrict;
alter table public.mfg_shopify_inventory_adjustments add column pilot_work_order_id bigint references public.mfg_work_orders(id) on delete restrict;
alter table public.mfg_transfer_handoffs add column pilot_identifier text references public.manufacturing_pilot_gate(pilot_identifier) on delete restrict;
alter table public.mfg_transfer_handoffs add column pilot_work_order_id bigint references public.mfg_work_orders(id) on delete restrict;
alter table public.shopify_transfer_links add column pilot_identifier text references public.manufacturing_pilot_gate(pilot_identifier) on delete restrict;
alter table public.shopify_transfer_links add column pilot_work_order_id bigint references public.mfg_work_orders(id) on delete restrict;
alter table public.mfg_audit_events add column pilot_identifier text references public.manufacturing_pilot_gate(pilot_identifier) on delete restrict;
alter table public.mfg_audit_events add column pilot_work_order_id bigint references public.mfg_work_orders(id) on delete restrict;

create index mfg_work_orders_pilot_idx on public.mfg_work_orders(pilot_identifier,pilot_work_order_id);
create index mfg_allocations_pilot_idx on public.mfg_component_allocations(pilot_identifier,pilot_work_order_id);
create index mfg_completion_pilot_idx on public.mfg_completion_events(pilot_identifier,pilot_work_order_id);
create index mfg_consumption_pilot_idx on public.mfg_component_consumption_events(pilot_identifier,pilot_work_order_id);
create index mfg_finished_pilot_idx on public.mfg_finished_inventory_events(pilot_identifier,pilot_work_order_id);
create index inventory_movements_pilot_idx on public.inventory_movements(pilot_identifier,pilot_work_order_id);
create index mfg_shopify_adjustments_pilot_claim_idx on public.mfg_shopify_inventory_adjustments(pilot_identifier,pilot_work_order_id,status,id);
create index mfg_handoffs_pilot_claim_idx on public.mfg_transfer_handoffs(pilot_identifier,pilot_work_order_id,status,id);
create index shopify_transfer_links_pilot_idx on public.shopify_transfer_links(pilot_identifier,pilot_work_order_id);
create index mfg_audit_pilot_idx on public.mfg_audit_events(pilot_identifier,pilot_work_order_id);

create or replace function public.guard_manufacturing_pilot_binding()
returns trigger language plpgsql security invoker set search_path='pg_catalog','public' as $$
begin
 if old.approved_work_order_id is distinct from new.approved_work_order_id and
   (old.enabled or new.enabled or (old.approved_work_order_id is not null and exists(
     select 1 from public.mfg_work_orders w where w.pilot_identifier=old.pilot_identifier
     union all select 1 from public.inventory_movements m where m.pilot_identifier=old.pilot_identifier
     union all select 1 from public.mfg_shopify_inventory_adjustments a where a.pilot_identifier=old.pilot_identifier
     union all select 1 from public.mfg_transfer_handoffs h where h.pilot_identifier=old.pilot_identifier)))
 then raise exception 'approved_pilot_work_order_immutable';end if;
 return new;
end $$;

create or replace function public.mfg_pilot_flag_enabled(p_flag text)
returns boolean language sql stable security invoker set search_path='pg_catalog','public' as $$
 select exists(select 1 from public.mfg_feature_flags where flag_key=p_flag and enabled)
$$;

create or replace function public.mfg_validate_pilot_work_order(p_work_order_id bigint,p_actor_user_id bigint default null)
returns public.manufacturing_pilot_gate language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare g public.manufacturing_pilot_gate%rowtype;w public.mfg_work_orders%rowtype;l public.mfg_work_order_lines%rowtype;
begin
 perform pg_advisory_xact_lock(hashtext('BM-MFG-PILOT-001'));
 select * into g from public.manufacturing_pilot_gate where pilot_identifier='BM-MFG-PILOT-001' for update;
 if not found or not g.enabled or g.approved_work_order_id is null or g.approved_work_order_id<>p_work_order_id then raise exception 'pilot_gate_disabled_or_unbound';end if;
 if p_actor_user_id is not null and not(p_actor_user_id=any(g.approved_user_ids)) then raise exception 'pilot_user_not_approved';end if;
 select * into w from public.mfg_work_orders where id=p_work_order_id for update;
 if not found or w.pilot_identifier<>g.pilot_identifier or w.pilot_work_order_id<>w.id
  or w.production_location_id<>g.origin_location_id or w.destination_location_id<>g.destination_location_id
  or w.machine_code<>g.machine_code then raise exception 'pilot_work_order_scope_mismatch';end if;
 select * into l from public.mfg_work_order_lines where work_order_id=w.id;
 if not found or (select count(*) from public.mfg_work_order_lines where work_order_id=w.id)<>1
  or l.finished_product_id<>g.approved_finished_product_id or l.planned_quantity<>1 then raise exception 'pilot_line_scope_mismatch';end if;
 if exists(select 1 from public.mfg_shortage_overrides where work_order_id=w.id) then raise exception 'pilot_shortage_override_forbidden';end if;
 if exists(select 1 from public.mfg_work_orders x where x.pilot_identifier is not null and x.id<>w.id and lower(x.status) not in('closed','cancelled'))
 then raise exception 'conflicting_active_pilot';end if;
 if not exists(select 1 from public.product_shopify_sources s where s.product_id=g.approved_finished_product_id
   and s.store_key=g.approved_shopify_store_key and s.shopify_inventory_item_id=g.approved_shopify_inventory_item_id)
 then raise exception 'pilot_shopify_identity_mismatch';end if;
 if not exists(select 1 from public.mfg_work_order_bom_snapshots s where s.work_order_line_id=l.id)
  and not exists(select 1 from public.mfg_bom_versions v where v.finished_product_id=l.finished_product_id and v.status='active' and v.source_bom_id=g.approved_bom_id)
 then raise exception 'pilot_approved_bom_not_active';end if;
 if exists(select 1 from public.mfg_work_order_bom_snapshots s where s.work_order_line_id=l.id
   and(s.source_bom_id<>g.approved_bom_id or s.finished_product_id<>g.approved_finished_product_id
    or s.component_hash is distinct from(select component_hash from public.mfg_bom_versions where id=s.bom_version_id)))
 then raise exception 'pilot_frozen_bom_mismatch';end if;
 return g;
end $$;

create or replace function public.run_manufacturing_pilot_action(
 p_actor_user_id bigint,p_work_order_id bigint,p_action text,p_idempotency_key text
) returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare g public.manufacturing_pilot_gate%rowtype;l public.mfg_work_order_lines%rowtype;r jsonb;
begin
 g:=public.mfg_validate_pilot_work_order(p_work_order_id,p_actor_user_id);
 if nullif(btrim(coalesce(p_idempotency_key,'')),'') is null then raise exception 'idempotency_key_required';end if;
 select * into l from public.mfg_work_order_lines where work_order_id=p_work_order_id;
 if p_action='release' then
  if not public.mfg_pilot_flag_enabled('manufacturing_pilot_release_enabled')
   or not public.mfg_pilot_flag_enabled('manufacturing_pilot_inventory_enabled') then raise exception 'pilot_release_disabled';end if;
  r:=public.release_mfg_work_order(p_actor_user_id,p_work_order_id,p_idempotency_key,null);
  perform public.mfg_validate_pilot_work_order(p_work_order_id,p_actor_user_id);
 elsif p_action='start' then
  if not public.mfg_pilot_flag_enabled('manufacturing_pilot_release_enabled') then raise exception 'pilot_start_disabled';end if;
  r:=public.transition_mfg_work_order(p_actor_user_id,p_work_order_id,'start',p_idempotency_key);
 elsif p_action='record_good_unit' then
  if not public.mfg_pilot_flag_enabled('manufacturing_pilot_completion_enabled')
   or not public.mfg_pilot_flag_enabled('manufacturing_pilot_inventory_enabled') then raise exception 'pilot_completion_disabled';end if;
  r:=public.record_mfg_progress(p_actor_user_id,p_work_order_id,l.id,'good','unstarted',1,'[]'::jsonb,
    'BM-MFG-PILOT-001 one good unit',p_idempotency_key);
 elsif p_action='complete' then
  if not public.mfg_pilot_flag_enabled('manufacturing_pilot_completion_enabled')
   or not public.mfg_pilot_flag_enabled('manufacturing_pilot_transfer_enabled') then raise exception 'pilot_transfer_disabled';end if;
  r:=public.complete_mfg_work_order(p_actor_user_id,p_work_order_id,p_idempotency_key);
 elsif p_action='close' then
  if not public.mfg_pilot_flag_enabled('manufacturing_pilot_completion_enabled') then raise exception 'pilot_close_disabled';end if;
  if not exists(select 1 from public.mfg_transfer_handoffs h join public.shopify_transfer_links s on s.id=h.shopify_transfer_link_id
    where h.work_order_id=p_work_order_id and h.pilot_identifier=g.pilot_identifier and h.pilot_work_order_id=p_work_order_id
      and lower(s.status) in('received','completed')) then raise exception 'pilot_transfer_receipt_required';end if;
  r:=public.close_mfg_work_order(p_actor_user_id,p_work_order_id,p_idempotency_key);
 else raise exception 'pilot_action_not_allowed';end if;
 return r;
end $$;

create or replace function public.bind_manufacturing_pilot_draft(p_actor_user_id bigint,p_work_order_id bigint)
returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare g public.manufacturing_pilot_gate%rowtype;w public.mfg_work_orders%rowtype;l public.mfg_work_order_lines%rowtype;
begin
 perform pg_advisory_xact_lock(hashtext('BM-MFG-PILOT-001'));
 select * into g from public.manufacturing_pilot_gate where pilot_identifier='BM-MFG-PILOT-001' for update;
 if not found or g.enabled or g.approved_work_order_id is not null then raise exception 'pilot_gate_must_be_disabled_and_unbound';end if;
 if not(p_actor_user_id=any(g.approved_user_ids)) then raise exception 'pilot_user_not_approved';end if;
 select * into w from public.mfg_work_orders where id=p_work_order_id for update;
 if not found or lower(w.status)<>'draft' or w.production_location_id<>6 or w.destination_location_id<>2 or w.machine_code<>'NIGHTHAWK'
 then raise exception 'pilot_draft_scope_mismatch';end if;
 select * into l from public.mfg_work_order_lines where work_order_id=w.id;
 if not found or (select count(*) from public.mfg_work_order_lines where work_order_id=w.id)<>1
  or l.finished_product_id<>g.approved_finished_product_id or l.planned_quantity<>1 then raise exception 'pilot_line_scope_mismatch';end if;
 if exists(select 1 from public.mfg_component_allocations where work_order_id=w.id)
  or exists(select 1 from public.mfg_completion_events where work_order_id=w.id)
  or exists(select 1 from public.inventory_movements where reference_type='manufacturing' and reference_id=w.id::text)
  or exists(select 1 from public.mfg_shopify_inventory_adjustments where work_order_id=w.id)
  or exists(select 1 from public.mfg_transfer_handoffs where work_order_id=w.id)
 then raise exception 'pilot_draft_has_effects';end if;
 update public.mfg_work_orders set pilot_identifier=g.pilot_identifier,pilot_work_order_id=id,updated_at=now() where id=w.id;
 update public.manufacturing_pilot_gate set approved_work_order_id=w.id where pilot_identifier=g.pilot_identifier;
 insert into public.mfg_audit_events(work_order_id,event_type,actor_user_id,idempotency_key,details,pilot_identifier,pilot_work_order_id)
 values(w.id,'pilot_draft_bound',p_actor_user_id,'BM-MFG-PILOT-001:bind:'||w.id,
  jsonb_build_object('pilotIdentifier',g.pilot_identifier,'approvedWorkOrderId',w.id,'inventoryEffect',false),g.pilot_identifier,w.id);
 return jsonb_build_object('pilotIdentifier',g.pilot_identifier,'approvedWorkOrderId',w.id,'enabled',false,'inventoryEffect',false);
end $$;

create or replace function public.guard_mfg_pilot_ownership()
returns trigger language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare v_pilot text;v_wo bigint;
begin
 if tg_table_name='mfg_work_orders' then
  if tg_op='UPDATE' and(old.pilot_identifier is distinct from new.pilot_identifier or old.pilot_work_order_id is distinct from new.pilot_work_order_id)
   and old.pilot_identifier is not null then raise exception 'pilot_ownership_immutable';end if;
  return new;
 end if;
 if tg_op='UPDATE' and(old.pilot_identifier is distinct from new.pilot_identifier or old.pilot_work_order_id is distinct from new.pilot_work_order_id)
 then raise exception 'pilot_ownership_immutable';end if;
 if tg_op='UPDATE' then return new;end if;
 if tg_table_name='mfg_component_allocations' or tg_table_name='mfg_completion_events' or tg_table_name='mfg_transfer_handoffs' or tg_table_name='mfg_audit_events' or tg_table_name='mfg_shopify_inventory_adjustments' then v_wo:=new.work_order_id;
 elsif tg_table_name='mfg_component_consumption_events' then select e.work_order_id into v_wo from public.mfg_completion_events e where e.id=new.completion_event_id;
 elsif tg_table_name='mfg_finished_inventory_events' then select e.work_order_id into v_wo from public.mfg_completion_events e where e.id=new.completion_event_id;
 elsif tg_table_name='inventory_movements' and new.reference_type='manufacturing' then v_wo:=new.reference_id::bigint;
 elsif tg_table_name='shopify_transfer_links' and new.manufacturing_handoff_id is not null then select h.work_order_id into v_wo from public.mfg_transfer_handoffs h where h.id=new.manufacturing_handoff_id;
 end if;
 if v_wo is not null then select w.pilot_identifier,w.pilot_work_order_id into v_pilot,v_wo from public.mfg_work_orders w where w.id=v_wo;end if;
 new.pilot_identifier:=v_pilot;new.pilot_work_order_id:=v_wo;return new;
end $$;

create trigger guard_mfg_work_order_pilot before update of pilot_identifier,pilot_work_order_id on public.mfg_work_orders for each row execute function public.guard_mfg_pilot_ownership();
create trigger guard_manufacturing_pilot_binding before update of approved_work_order_id on public.manufacturing_pilot_gate for each row execute function public.guard_manufacturing_pilot_binding();
create trigger stamp_mfg_alloc_pilot before insert or update of pilot_identifier,pilot_work_order_id on public.mfg_component_allocations for each row execute function public.guard_mfg_pilot_ownership();
create trigger stamp_mfg_completion_pilot before insert or update of pilot_identifier,pilot_work_order_id on public.mfg_completion_events for each row execute function public.guard_mfg_pilot_ownership();
create trigger stamp_mfg_consumption_pilot before insert or update of pilot_identifier,pilot_work_order_id on public.mfg_component_consumption_events for each row execute function public.guard_mfg_pilot_ownership();
create trigger stamp_mfg_finished_pilot before insert or update of pilot_identifier,pilot_work_order_id on public.mfg_finished_inventory_events for each row execute function public.guard_mfg_pilot_ownership();
create trigger stamp_inventory_movement_pilot before insert or update of pilot_identifier,pilot_work_order_id on public.inventory_movements for each row execute function public.guard_mfg_pilot_ownership();
create trigger stamp_mfg_adjustment_pilot before insert or update of pilot_identifier,pilot_work_order_id on public.mfg_shopify_inventory_adjustments for each row execute function public.guard_mfg_pilot_ownership();
create trigger stamp_mfg_handoff_pilot before insert or update of pilot_identifier,pilot_work_order_id on public.mfg_transfer_handoffs for each row execute function public.guard_mfg_pilot_ownership();
create trigger stamp_shopify_link_pilot before insert or update of pilot_identifier,pilot_work_order_id on public.shopify_transfer_links for each row execute function public.guard_mfg_pilot_ownership();
create trigger stamp_mfg_audit_pilot before insert or update of pilot_identifier,pilot_work_order_id on public.mfg_audit_events for each row execute function public.guard_mfg_pilot_ownership();

create or replace function public.mfg_worker_record_eligible(p_work_order_id bigint,p_pilot_identifier text,p_pilot_work_order_id bigint,p_capability text,p_general_flag text)
returns boolean language plpgsql stable security invoker set search_path='pg_catalog','public' as $$
declare g public.manufacturing_pilot_gate%rowtype;
begin
 if p_pilot_identifier is null and p_pilot_work_order_id is null then
  return public.mfg_pilot_flag_enabled(p_general_flag)
   and case when p_general_flag='manufacturing_shopify_outbound_enabled' then public.mfg_pilot_flag_enabled('manufacturing_inventory_mutations_enabled')
            when p_general_flag='manufacturing_transfer_handoff_enabled' then public.mfg_pilot_flag_enabled('manufacturing_shopify_outbound_enabled')
            else false end;
 end if;
 if p_pilot_identifier is null or p_pilot_work_order_id is null or p_work_order_id<>p_pilot_work_order_id then return false;end if;
 select * into g from public.manufacturing_pilot_gate where pilot_identifier=p_pilot_identifier;
 return found and g.enabled and g.approved_work_order_id=p_work_order_id
  and public.mfg_pilot_flag_enabled(p_capability)
  and case when p_capability='manufacturing_pilot_outbound_enabled' then public.mfg_pilot_flag_enabled('manufacturing_pilot_inventory_enabled')
           when p_capability='manufacturing_pilot_transfer_enabled' then public.mfg_pilot_flag_enabled('manufacturing_pilot_outbound_enabled')
           else false end
  and p_pilot_identifier='BM-MFG-PILOT-001'
  and exists(select 1 from public.mfg_work_orders w join public.mfg_work_order_lines l on l.work_order_id=w.id
    where w.id=p_work_order_id and w.pilot_identifier=p_pilot_identifier and w.pilot_work_order_id=w.id
      and w.production_location_id=g.origin_location_id and w.destination_location_id=g.destination_location_id
      and w.machine_code=g.machine_code and l.finished_product_id=g.approved_finished_product_id and l.planned_quantity=1
      and (select count(*) from public.mfg_work_order_lines x where x.work_order_id=w.id)=1)
  and not exists(select 1 from public.mfg_work_orders x where x.pilot_identifier is not null and x.id<>p_work_order_id and lower(x.status) not in('closed','cancelled'));
end $$;

create or replace function public.assert_mfg_worker_claim_eligible(p_kind text,p_record_id bigint,p_lease_token uuid)
returns void language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare v_wo bigint;v_pilot text;v_pilot_wo bigint;v_ok boolean;
begin
 if p_kind='inventory' then
  select work_order_id,pilot_identifier,pilot_work_order_id into v_wo,v_pilot,v_pilot_wo
  from public.mfg_shopify_inventory_adjustments where id=p_record_id and status='processing' and lease_token=p_lease_token for update;
  if not found then raise exception 'manufacturing_shopify_lease_lost';end if;
  v_ok:=public.mfg_worker_record_eligible(v_wo,v_pilot,v_pilot_wo,'manufacturing_pilot_outbound_enabled','manufacturing_shopify_outbound_enabled');
 elsif p_kind='transfer' then
  select work_order_id,pilot_identifier,pilot_work_order_id into v_wo,v_pilot,v_pilot_wo
  from public.mfg_transfer_handoffs where id=p_record_id and status='processing' and lease_token=p_lease_token for update;
  if not found then raise exception 'manufacturing_handoff_lease_lost';end if;
  v_ok:=public.mfg_worker_record_eligible(v_wo,v_pilot,v_pilot_wo,'manufacturing_pilot_transfer_enabled','manufacturing_transfer_handoff_enabled');
 else raise exception 'unknown_manufacturing_worker_kind';end if;
 if not coalesce(v_ok,false) then raise exception 'manufacturing_worker_record_not_eligible';end if;
 if v_pilot is not null then perform public.mfg_validate_pilot_work_order(v_wo,null);end if;
end $$;

-- Worker claims are the authorization boundary. Missing/ambiguous ownership is ineligible.
create or replace function public.claim_mfg_shopify_inventory_adjustment(p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path='pg_catalog','public' as $$
declare q public.mfg_shopify_inventory_adjustments%rowtype;t uuid:=gen_random_uuid();
begin
 select x.* into q from public.mfg_shopify_inventory_adjustments x
 where (x.status in('pending','failed') or(x.status='processing' and x.lease_expires_at<now()))
  and public.mfg_worker_record_eligible(x.work_order_id,x.pilot_identifier,x.pilot_work_order_id,'manufacturing_pilot_outbound_enabled','manufacturing_shopify_outbound_enabled')
  and not exists(select 1 from public.mfg_shopify_inventory_adjustments prior where prior.store_key=x.store_key and prior.shopify_location_id=x.shopify_location_id
   and prior.shopify_inventory_item_id=x.shopify_inventory_item_id and prior.id<x.id and prior.status<>'confirmed')
 order by x.id for update skip locked limit 1;
 if not found then return null;end if;
 perform public.mfg_validate_pilot_work_order(q.work_order_id,null) where q.pilot_identifier is not null;
 update public.mfg_shopify_inventory_adjustments set status='processing',attempts=attempts+1,lease_token=t,
  lease_expires_at=now()+make_interval(secs=>greatest(p_lease_seconds,15)),updated_at=now() where id=q.id;
 return jsonb_build_object('id',q.id,'workOrderId',q.work_order_id,'pilotIdentifier',q.pilot_identifier,'pilotWorkOrderId',q.pilot_work_order_id,
  'storeKey',q.store_key,'shopifyLocationId',q.shopify_location_id,'shopifyInventoryItemId',q.shopify_inventory_item_id,
  'quantityDelta',q.quantity_delta,'idempotencyKey',q.idempotency_key,'leaseToken',t,'attempt',q.attempts+1);
end $$;

-- Claim only an exact normal/global or exact pilot handoff. Refresh only eligible rows.
create or replace function public.claim_mfg_transfer_handoff(p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path='pg_catalog','public' as $$
declare h public.mfg_transfer_handoffs%rowtype;t uuid:=gen_random_uuid();
begin
 for h in select x.* from public.mfg_transfer_handoffs x where x.status in('pending_inventory_confirmation','blocked_mapping')
   and public.mfg_worker_record_eligible(x.work_order_id,x.pilot_identifier,x.pilot_work_order_id,'manufacturing_pilot_transfer_enabled','manufacturing_transfer_handoff_enabled')
   order by x.id for update skip locked loop perform public.refresh_mfg_transfer_handoff(h.id);end loop;
 select x.* into h from public.mfg_transfer_handoffs x where
  (x.status='ready' or(x.status='retryable_error' and coalesce(x.next_retry_at,now())<=now())or(x.status='processing' and x.lease_expires_at<now()))
  and public.mfg_worker_record_eligible(x.work_order_id,x.pilot_identifier,x.pilot_work_order_id,'manufacturing_pilot_transfer_enabled','manufacturing_transfer_handoff_enabled')
 order by x.id for update skip locked limit 1;
 if not found then return null;end if;
 perform public.mfg_validate_pilot_work_order(h.work_order_id,null) where h.pilot_identifier is not null;
 update public.mfg_transfer_handoffs set status=case when h.status='processing' then 'ready' else status end where id=h.id;
 update public.mfg_transfer_handoffs set status='processing',attempt_count=attempt_count+1,lease_token=t,
  lease_expires_at=now()+make_interval(secs=>greatest(p_lease_seconds,15)),last_error=null,updated_at=now() where id=h.id;
 return jsonb_build_object('id',h.id,'workOrderId',h.work_order_id,'pilotIdentifier',h.pilot_identifier,'pilotWorkOrderId',h.pilot_work_order_id,
  'workOrderNumber',h.work_order_number,'sourceLocationId',h.source_location_id,'destinationLocationId',h.destination_location_id,
  'storeKey',h.source_store_key,'sourceShopifyLocationId',h.source_shopify_location_id,'destinationShopifyLocationId',h.destination_shopify_location_id,
  'idempotencyKey',h.idempotency_key,'leaseToken',t,'attempt',h.attempt_count+1);
end $$;

revoke all on function public.mfg_pilot_flag_enabled(text) from public,anon,authenticated;
revoke all on function public.mfg_validate_pilot_work_order(bigint,bigint) from public,anon,authenticated;
revoke all on function public.bind_manufacturing_pilot_draft(bigint,bigint) from public,anon,authenticated;
revoke all on function public.run_manufacturing_pilot_action(bigint,bigint,text,text) from public,anon,authenticated;
revoke all on function public.mfg_worker_record_eligible(bigint,text,bigint,text,text) from public,anon,authenticated;
revoke all on function public.assert_mfg_worker_claim_eligible(text,bigint,uuid) from public,anon,authenticated;
grant execute on function public.mfg_pilot_flag_enabled(text),public.mfg_validate_pilot_work_order(bigint,bigint),public.bind_manufacturing_pilot_draft(bigint,bigint),public.run_manufacturing_pilot_action(bigint,bigint,text,text),public.mfg_worker_record_eligible(bigint,text,bigint,text,text),public.assert_mfg_worker_claim_eligible(text,bigint,uuid) to service_role;
revoke execute on function public.create_manufacturing_pilot_draft(text,bigint) from service_role;
revoke execute on function public.advance_manufacturing_pilot(bigint,text,bigint,text) from service_role;

commit;
