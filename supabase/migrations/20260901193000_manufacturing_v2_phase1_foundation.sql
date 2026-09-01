-- Additive Manufacturing V2 foundation. The existing production_* and Qoblex-imported
-- product_bom* records are intentionally preserved.

revoke all on function public.start_v2_stock_production_job(bigint,jsonb,text,text,text,bigint,text)
  from public, anon, authenticated;
grant execute on function public.start_v2_stock_production_job(bigint,jsonb,text,text,text,bigint,text)
  to service_role;

create table public.mfg_feature_flags (
  flag_key text primary key,
  enabled boolean not null default false,
  notes text,
  updated_by bigint references public.app_users(id) on delete set null,
  updated_at timestamptz not null default now(),
  check (flag_key = 'manufacturing_v2')
);
insert into public.mfg_feature_flags(flag_key,enabled,notes)
values ('manufacturing_v2',false,'Phase 1 foundation installed; no user-facing route enabled')
on conflict (flag_key) do nothing;

create table public.mfg_role_permissions (
  role text not null,
  permission text not null check (permission in (
    'draft_create','release','machine_assign','start_pause','partial_complete',
    'scrap_rework','shortage_override','cancel','close','bom_admin','cost_admin'
  )),
  allowed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(role,permission)
);

create table public.mfg_user_permission_overrides (
  user_id bigint not null references public.app_users(id) on delete cascade,
  permission text not null check (permission in (
    'draft_create','release','machine_assign','start_pause','partial_complete',
    'scrap_rework','shortage_override','cancel','close','bom_admin','cost_admin'
  )),
  allowed boolean not null,
  reason text not null check (btrim(reason) <> ''),
  granted_by bigint references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(user_id,permission)
);

insert into public.mfg_role_permissions(role,permission,allowed)
select 'admin',p,true from unnest(array[
  'draft_create','release','machine_assign','start_pause','partial_complete',
  'scrap_rework','shortage_override','cancel','close','bom_admin','cost_admin'
]) p
union all
select 'manager',p,true from unnest(array[
  'draft_create','release','machine_assign','start_pause','partial_complete',
  'scrap_rework','cancel','close'
]) p
union all
select 'manager',p,false from unnest(array['shortage_override','bom_admin','cost_admin']) p
union all
select 'warehouse',p,false from unnest(array[
  'draft_create','release','machine_assign','start_pause','partial_complete',
  'scrap_rework','shortage_override','cancel','close','bom_admin','cost_admin'
]) p
on conflict(role,permission) do update set allowed=excluded.allowed,updated_at=now();

create table public.mfg_bom_versions (
  id bigint generated always as identity primary key,
  source_bom_id bigint not null references public.product_boms(id) on delete restrict,
  version_number integer not null check (version_number > 0),
  finished_product_id bigint not null references public.products(id) on delete restrict,
  yield_quantity numeric not null check (yield_quantity > 0),
  status text not null check (status in ('draft','active','retired')),
  source_type text not null default 'qoblex_import' check (source_type in ('qoblex_import','bm_manual')),
  source_reference text,
  component_hash text not null,
  notes text,
  created_by bigint references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  retired_at timestamptz,
  unique(source_bom_id,version_number)
);
create unique index mfg_bom_versions_one_active_idx on public.mfg_bom_versions(source_bom_id) where status='active';

create table public.mfg_bom_version_components (
  id bigint generated always as identity primary key,
  bom_version_id bigint not null references public.mfg_bom_versions(id) on delete restrict,
  component_product_id bigint not null references public.products(id) on delete restrict,
  quantity_per_yield numeric not null check (quantity_per_yield > 0),
  created_at timestamptz not null default now(),
  unique(bom_version_id,component_product_id)
);

with source_rows as (
  select b.id source_bom_id,b.finished_product_id,b.yield_quantity,b.notes,
    md5(string_agg(c.component_product_id||':'||c.quantity_per_yield,'|' order by c.component_product_id)) component_hash,
    s.finished_sku
  from public.product_boms b
  join public.product_bom_components c on c.bom_id=b.id
  left join public.v1_door_bom_sources s on s.v2_finished_product_id=b.finished_product_id and s.match_status='matched'
  where b.active
  group by b.id,s.finished_sku
)
insert into public.mfg_bom_versions(source_bom_id,version_number,finished_product_id,yield_quantity,status,source_type,source_reference,component_hash,notes,activated_at)
select source_bom_id,1,finished_product_id,yield_quantity,'active',
       case when finished_sku is null then 'bm_manual' else 'qoblex_import' end,
       finished_sku,component_hash,notes,now()
from source_rows
on conflict(source_bom_id,version_number) do nothing;

insert into public.mfg_bom_version_components(bom_version_id,component_product_id,quantity_per_yield)
select v.id,c.component_product_id,c.quantity_per_yield
from public.mfg_bom_versions v
join public.product_bom_components c on c.bom_id=v.source_bom_id
where v.version_number=1
on conflict(bom_version_id,component_product_id) do nothing;

create sequence public.mfg_work_order_number_seq;

create table public.mfg_work_orders (
  id bigint generated always as identity primary key,
  work_order_number text not null unique,
  production_location_id bigint not null references public.locations(id) on delete restrict,
  destination_location_id bigint not null references public.locations(id) on delete restrict,
  machine_code text not null check (machine_code in ('NIGHTHAWK','TERMINATOR')),
  status text not null default 'Draft' check (status in (
    'Draft','Released','In Production','Paused','Partially Completed',
    'Completed','Cancelled','Closed'
  )),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  requested_completion_date date,
  notes text,
  creation_idempotency_key text not null unique check (btrim(creation_idempotency_key)<>''),
  release_idempotency_key text unique,
  cancellation_idempotency_key text unique,
  created_by bigint not null references public.app_users(id) on delete restrict,
  released_by bigint references public.app_users(id) on delete restrict,
  cancelled_by bigint references public.app_users(id) on delete restrict,
  cancellation_reason text,
  created_at timestamptz not null default now(),
  released_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (production_location_id<>destination_location_id),
  check ((status<>'Cancelled') or (cancellation_reason is not null and btrim(cancellation_reason)<>''))
);
create index mfg_work_orders_queue_idx on public.mfg_work_orders(machine_code,status,priority,requested_completion_date,created_at);
create index mfg_work_orders_destination_idx on public.mfg_work_orders(destination_location_id,status);

create table public.mfg_work_order_lines (
  id bigint generated always as identity primary key,
  work_order_id bigint not null references public.mfg_work_orders(id) on delete restrict,
  finished_product_id bigint not null references public.products(id) on delete restrict,
  planned_quantity numeric not null check (planned_quantity>0),
  good_quantity numeric not null default 0 check (good_quantity>=0),
  rejected_quantity numeric not null default 0 check (rejected_quantity>=0),
  scrap_quantity numeric not null default 0 check (scrap_quantity>=0),
  rework_quantity numeric not null default 0 check (rework_quantity>=0),
  remaining_quantity numeric generated always as (greatest(planned_quantity-good_quantity-rejected_quantity-scrap_quantity,0)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(work_order_id,finished_product_id),
  check (good_quantity+rejected_quantity+scrap_quantity<=planned_quantity)
);

create table public.mfg_work_order_bom_snapshots (
  id bigint generated always as identity primary key,
  work_order_line_id bigint not null unique references public.mfg_work_order_lines(id) on delete restrict,
  bom_version_id bigint not null references public.mfg_bom_versions(id) on delete restrict,
  source_bom_id bigint not null references public.product_boms(id) on delete restrict,
  finished_product_id bigint not null references public.products(id) on delete restrict,
  yield_quantity numeric not null check (yield_quantity>0),
  component_hash text not null,
  frozen_at timestamptz not null default now()
);

create table public.mfg_work_order_snapshot_components (
  id bigint generated always as identity primary key,
  snapshot_id bigint not null references public.mfg_work_order_bom_snapshots(id) on delete restrict,
  component_product_id bigint not null references public.products(id) on delete restrict,
  quantity_per_yield numeric not null check (quantity_per_yield>0),
  frozen_required_quantity numeric not null check (frozen_required_quantity>0),
  created_at timestamptz not null default now(),
  unique(snapshot_id,component_product_id)
);

create table public.mfg_component_allocations (
  id bigint generated always as identity primary key,
  work_order_id bigint not null references public.mfg_work_orders(id) on delete restrict,
  component_product_id bigint not null references public.products(id) on delete restrict,
  required_quantity numeric not null check (required_quantity>0),
  allocated_quantity numeric not null check (allocated_quantity>=0 and allocated_quantity<=required_quantity),
  consumed_quantity numeric not null default 0 check (consumed_quantity>=0 and consumed_quantity<=allocated_quantity),
  released_quantity numeric not null default 0 check (released_quantity>=0 and released_quantity<=allocated_quantity),
  status text not null default 'pending' check (status in ('pending','active','partially_consumed','consumed','released')),
  allocation_idempotency_key text not null unique,
  allocated_at timestamptz,
  released_at timestamptz,
  unique(work_order_id,component_product_id),
  check (consumed_quantity+released_quantity<=allocated_quantity)
);
create index mfg_component_allocations_availability_idx on public.mfg_component_allocations(component_product_id,status);

create table public.mfg_shortage_overrides (
  id bigint generated always as identity primary key,
  work_order_id bigint not null references public.mfg_work_orders(id) on delete restrict,
  component_product_id bigint not null references public.products(id) on delete restrict,
  required_quantity numeric not null,
  signed_available_quantity numeric not null,
  shortage_quantity numeric not null check (shortage_quantity>0),
  reason text not null check (btrim(reason)<>''),
  overridden_by bigint not null references public.app_users(id) on delete restrict,
  overridden_at timestamptz not null default now(),
  unique(work_order_id,component_product_id)
);

create table public.mfg_planned_transfers (
  id bigint generated always as identity primary key,
  work_order_id bigint not null unique references public.mfg_work_orders(id) on delete restrict,
  production_location_id bigint not null references public.locations(id) on delete restrict,
  destination_location_id bigint not null references public.locations(id) on delete restrict,
  status text not null default 'planned' check (status in ('planned','ready','cancelled','promoted')),
  idempotency_key text not null unique,
  physical_transfer_id bigint unique references public.transfers(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.mfg_planned_transfer_lines (
  id bigint generated always as identity primary key,
  planned_transfer_id bigint not null references public.mfg_planned_transfers(id) on delete restrict,
  product_id bigint not null references public.products(id) on delete restrict,
  planned_quantity numeric not null check (planned_quantity>0),
  transferable_quantity numeric not null default 0 check (transferable_quantity>=0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(planned_transfer_id,product_id),
  check (transferable_quantity<=planned_quantity)
);

create table public.mfg_completion_events (
  id bigint generated always as identity primary key,
  work_order_id bigint not null references public.mfg_work_orders(id) on delete restrict,
  work_order_line_id bigint not null references public.mfg_work_order_lines(id) on delete restrict,
  good_quantity numeric not null default 0 check (good_quantity>=0),
  rejected_quantity numeric not null default 0 check (rejected_quantity>=0),
  scrap_quantity numeric not null default 0 check (scrap_quantity>=0),
  rework_quantity numeric not null default 0 check (rework_quantity>=0),
  notes text,
  idempotency_key text not null unique,
  recorded_by bigint not null references public.app_users(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  check (good_quantity+rejected_quantity+scrap_quantity+rework_quantity>0)
);

create table public.mfg_component_consumption_events (
  id bigint generated always as identity primary key,
  completion_event_id bigint not null references public.mfg_completion_events(id) on delete restrict,
  component_product_id bigint not null references public.products(id) on delete restrict,
  quantity numeric not null check (quantity>0),
  cost_per_unit_snapshot numeric,
  cost_source text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  unique(completion_event_id,component_product_id)
);

create table public.mfg_finished_inventory_events (
  id bigint generated always as identity primary key,
  completion_event_id bigint not null references public.mfg_completion_events(id) on delete restrict,
  product_id bigint not null references public.products(id) on delete restrict,
  location_id bigint not null references public.locations(id) on delete restrict,
  good_quantity numeric not null check (good_quantity>0),
  inventory_movement_id bigint unique references public.inventory_movements(id) on delete restrict,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create table public.mfg_standard_labor_rules (
  id bigint generated always as identity primary key,
  finished_product_id bigint references public.products(id) on delete restrict,
  door_family text,
  labor_cost_per_unit numeric not null check (labor_cost_per_unit>=0),
  overhead_per_unit numeric check (overhead_per_unit>=0),
  source_version text not null,
  active boolean not null default true,
  effective_at timestamptz not null default now(),
  retired_at timestamptz,
  configured_by bigint not null references public.app_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  check ((finished_product_id is not null) <> (door_family is not null))
);
create unique index mfg_labor_rule_product_active_idx on public.mfg_standard_labor_rules(finished_product_id) where active and finished_product_id is not null;
create unique index mfg_labor_rule_family_active_idx on public.mfg_standard_labor_rules(door_family) where active and door_family is not null;

create table public.mfg_cost_snapshots (
  id bigint generated always as identity primary key,
  completion_event_id bigint not null unique references public.mfg_completion_events(id) on delete restrict,
  component_cost numeric,
  labor_cost numeric,
  overhead_cost numeric,
  total_manufacturing_cost numeric,
  finished_unit_cost numeric,
  cost_status text not null check (cost_status in ('available','unavailable')),
  unavailable_reason text,
  cost_source_version text,
  costed_at timestamptz not null default now(),
  check ((cost_status='available' and component_cost is not null and labor_cost is not null and total_manufacturing_cost is not null and finished_unit_cost is not null)
      or (cost_status='unavailable' and unavailable_reason is not null))
);

create table public.mfg_cost_snapshot_components (
  id bigint generated always as identity primary key,
  cost_snapshot_id bigint not null references public.mfg_cost_snapshots(id) on delete restrict,
  component_product_id bigint not null references public.products(id) on delete restrict,
  consumed_quantity numeric not null check (consumed_quantity>0),
  unit_cost numeric,
  extended_cost numeric,
  cost_source text,
  unique(cost_snapshot_id,component_product_id)
);

create table public.mfg_work_order_notes (
  id bigint generated always as identity primary key,
  work_order_id bigint not null references public.mfg_work_orders(id) on delete restrict,
  note text not null check (btrim(note)<>''),
  created_by bigint not null references public.app_users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.mfg_status_history (
  id bigint generated always as identity primary key,
  work_order_id bigint not null references public.mfg_work_orders(id) on delete restrict,
  from_status text,
  to_status text not null,
  reason text,
  changed_by bigint not null references public.app_users(id) on delete restrict,
  idempotency_key text not null unique,
  changed_at timestamptz not null default now()
);

create table public.mfg_audit_events (
  id bigint generated always as identity primary key,
  work_order_id bigint references public.mfg_work_orders(id) on delete restrict,
  event_type text not null,
  actor_user_id bigint not null references public.app_users(id) on delete restrict,
  idempotency_key text not null unique,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create or replace function public.mfg_actor_can(p_actor_user_id bigint,p_permission text)
returns boolean language sql stable security invoker set search_path='pg_catalog','public' as $$
  select coalesce(
    (select o.allowed from public.mfg_user_permission_overrides o where o.user_id=p_actor_user_id and o.permission=p_permission),
    (select rp.allowed from public.app_users u join public.mfg_role_permissions rp on rp.role=u.role and rp.permission=p_permission where u.id=p_actor_user_id and u.active),
    false
  )
$$;

create or replace function public.create_mfg_work_order_draft(
  p_actor_user_id bigint,p_destination_location_id bigint,p_machine_code text,p_lines jsonb,
  p_priority text,p_requested_completion_date date,p_notes text,p_idempotency_key text
) returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare v_existing public.mfg_work_orders%rowtype; v_wo public.mfg_work_orders%rowtype; v_730 bigint;
begin
  if not public.mfg_actor_can(p_actor_user_id,'draft_create') then raise exception 'manufacturing_permission_denied:draft_create'; end if;
  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is null then raise exception 'idempotency_key_required'; end if;
  select * into v_existing from public.mfg_work_orders where creation_idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('alreadyCreated',true,'workOrderId',v_existing.id,'workOrderNumber',v_existing.work_order_number); end if;
  select id into v_730 from public.locations where active and code='730' order by id limit 1;
  if v_730 is null then raise exception 'production_location_730_missing'; end if;
  if p_destination_location_id=v_730 then raise exception 'destination_must_differ_from_730'; end if;
  if upper(btrim(coalesce(p_machine_code,''))) not in ('NIGHTHAWK','TERMINATOR') then raise exception 'invalid_machine'; end if;
  if coalesce(p_priority,'normal') not in ('low','normal','high','urgent') then raise exception 'invalid_priority'; end if;
  if not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=v_730 and can_manage) or
     not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=p_destination_location_id and can_manage)
  then raise exception 'manufacturing_location_permission_denied'; end if;
  if jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'work_order_lines_required'; end if;
  if exists(select 1 from jsonb_to_recordset(p_lines) x(product_id bigint,planned_quantity numeric)
            left join public.products p on p.id=x.product_id and p.active
            where p.id is null or x.planned_quantity is null or x.planned_quantity<=0) then raise exception 'invalid_work_order_line'; end if;
  if (select count(*) from jsonb_to_recordset(p_lines) x(product_id bigint,planned_quantity numeric)) <>
     (select count(distinct product_id) from jsonb_to_recordset(p_lines) x(product_id bigint,planned_quantity numeric)) then raise exception 'duplicate_finished_product'; end if;
  insert into public.mfg_work_orders(work_order_number,production_location_id,destination_location_id,machine_code,priority,requested_completion_date,notes,creation_idempotency_key,created_by)
  values('MWO-'||to_char(current_date,'YYYYMMDD')||'-'||lpad(nextval('public.mfg_work_order_number_seq')::text,6,'0'),v_730,p_destination_location_id,upper(btrim(p_machine_code)),coalesce(p_priority,'normal'),p_requested_completion_date,nullif(btrim(coalesce(p_notes,'')),''),p_idempotency_key,p_actor_user_id)
  returning * into v_wo;
  insert into public.mfg_work_order_lines(work_order_id,finished_product_id,planned_quantity)
  select v_wo.id,x.product_id,x.planned_quantity from jsonb_to_recordset(p_lines) x(product_id bigint,planned_quantity numeric);
  insert into public.mfg_status_history(work_order_id,from_status,to_status,changed_by,idempotency_key)
  values(v_wo.id,null,'Draft',p_actor_user_id,p_idempotency_key||':status:draft');
  insert into public.mfg_audit_events(work_order_id,event_type,actor_user_id,idempotency_key,details)
  values(v_wo.id,'draft_created',p_actor_user_id,p_idempotency_key||':audit:draft',jsonb_build_object('lineCount',jsonb_array_length(p_lines),'inventoryEffect',false));
  return jsonb_build_object('alreadyCreated',false,'workOrderId',v_wo.id,'workOrderNumber',v_wo.work_order_number,'status','Draft');
end $$;

create or replace function public.release_mfg_work_order(
  p_actor_user_id bigint,p_work_order_id bigint,p_idempotency_key text,p_shortage_override_reason text default null
) returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare v_wo public.mfg_work_orders%rowtype; v_line record; v_comp record; v_snapshot_id bigint;
        v_available numeric; v_other_alloc numeric; v_shortage_count integer:=0; v_plan_id bigint;
begin
  if not public.mfg_actor_can(p_actor_user_id,'release') then raise exception 'manufacturing_permission_denied:release'; end if;
  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is null then raise exception 'idempotency_key_required'; end if;
  select * into v_wo from public.mfg_work_orders where id=p_work_order_id for update;
  if not found then raise exception 'work_order_not_found'; end if;
  if v_wo.status='Released' and v_wo.release_idempotency_key=p_idempotency_key then
    return jsonb_build_object('alreadyReleased',true,'workOrderId',v_wo.id,'plannedTransferId',(select id from public.mfg_planned_transfers where work_order_id=v_wo.id));
  end if;
  if v_wo.status<>'Draft' then raise exception 'only_draft_can_be_released'; end if;
  if not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=v_wo.production_location_id and can_manage) or
     not exists(select 1 from public.user_location_access where user_id=p_actor_user_id and location_id=v_wo.destination_location_id and can_manage)
  then raise exception 'manufacturing_location_permission_denied'; end if;
  if exists(select 1 from public.mfg_work_order_lines l left join public.mfg_bom_versions v on v.finished_product_id=l.finished_product_id and v.status='active'
            where l.work_order_id=v_wo.id and v.id is null) then raise exception 'valid_active_bom_required'; end if;
  if exists(select 1 from public.mfg_work_order_lines l join public.mfg_bom_versions v on v.finished_product_id=l.finished_product_id and v.status='active'
            where l.work_order_id=v_wo.id and not exists(select 1 from public.mfg_bom_version_components c where c.bom_version_id=v.id)) then raise exception 'bom_components_required'; end if;

  for v_line in
    select l.*,v.id bom_version_id,v.source_bom_id,v.yield_quantity,v.component_hash
    from public.mfg_work_order_lines l join public.mfg_bom_versions v on v.finished_product_id=l.finished_product_id and v.status='active'
    where l.work_order_id=v_wo.id order by l.id
  loop
    insert into public.mfg_work_order_bom_snapshots(work_order_line_id,bom_version_id,source_bom_id,finished_product_id,yield_quantity,component_hash)
    values(v_line.id,v_line.bom_version_id,v_line.source_bom_id,v_line.finished_product_id,v_line.yield_quantity,v_line.component_hash)
    returning id into v_snapshot_id;
    insert into public.mfg_work_order_snapshot_components(snapshot_id,component_product_id,quantity_per_yield,frozen_required_quantity)
    select v_snapshot_id,c.component_product_id,c.quantity_per_yield,v_line.planned_quantity*c.quantity_per_yield/v_line.yield_quantity
    from public.mfg_bom_version_components c where c.bom_version_id=v_line.bom_version_id;
  end loop;

  insert into public.mfg_component_allocations(work_order_id,component_product_id,required_quantity,allocated_quantity,status,allocation_idempotency_key)
  select v_wo.id,sc.component_product_id,sum(sc.frozen_required_quantity),sum(sc.frozen_required_quantity),'pending',p_idempotency_key||':allocate:'||sc.component_product_id
  from public.mfg_work_order_snapshot_components sc join public.mfg_work_order_bom_snapshots s on s.id=sc.snapshot_id
  join public.mfg_work_order_lines l on l.id=s.work_order_line_id where l.work_order_id=v_wo.id
  group by sc.component_product_id;

  for v_comp in select * from public.mfg_component_allocations where work_order_id=v_wo.id order by component_product_id loop
    perform pg_advisory_xact_lock(hashtextextended('mfg-component:'||v_wo.production_location_id||':'||v_comp.component_product_id,0));
  end loop;

  for v_comp in select * from public.mfg_component_allocations where work_order_id=v_wo.id order by component_product_id loop
    select coalesce(sum(a.allocated_quantity-a.consumed_quantity-a.released_quantity),0) into v_other_alloc
    from public.mfg_component_allocations a where a.component_product_id=v_comp.component_product_id and a.work_order_id<>v_wo.id and a.status in ('active','partially_consumed');
    select coalesce(ib.quantity,0)-coalesce(ib.allocated_quantity,0)-v_other_alloc into v_available
    from (select 1) x left join public.inventory_balances ib on ib.product_id=v_comp.component_product_id and ib.location_id=v_wo.production_location_id;
    if v_available<v_comp.required_quantity then
      v_shortage_count:=v_shortage_count+1;
      if nullif(btrim(coalesce(p_shortage_override_reason,'')),'') is not null then
        insert into public.mfg_shortage_overrides(work_order_id,component_product_id,required_quantity,signed_available_quantity,shortage_quantity,reason,overridden_by)
        values(v_wo.id,v_comp.component_product_id,v_comp.required_quantity,v_available,v_comp.required_quantity-v_available,btrim(p_shortage_override_reason),p_actor_user_id);
      end if;
    end if;
  end loop;
  if v_shortage_count>0 then
    if nullif(btrim(coalesce(p_shortage_override_reason,'')),'') is null then raise exception 'component_shortage_blocks_release'; end if;
    if not public.mfg_actor_can(p_actor_user_id,'shortage_override') then raise exception 'manufacturing_permission_denied:shortage_override'; end if;
  end if;

  update public.mfg_component_allocations set status='active',allocated_at=now() where work_order_id=v_wo.id and status='pending';
  insert into public.mfg_planned_transfers(work_order_id,production_location_id,destination_location_id,idempotency_key)
  values(v_wo.id,v_wo.production_location_id,v_wo.destination_location_id,p_idempotency_key||':planned-transfer') returning id into v_plan_id;
  insert into public.mfg_planned_transfer_lines(planned_transfer_id,product_id,planned_quantity,transferable_quantity)
  select v_plan_id,finished_product_id,planned_quantity,0 from public.mfg_work_order_lines where work_order_id=v_wo.id;
  update public.mfg_work_orders set status='Released',release_idempotency_key=p_idempotency_key,released_by=p_actor_user_id,released_at=now(),updated_at=now() where id=v_wo.id;
  insert into public.mfg_status_history(work_order_id,from_status,to_status,changed_by,idempotency_key)
  values(v_wo.id,'Draft','Released',p_actor_user_id,p_idempotency_key||':status:released');
  insert into public.mfg_audit_events(work_order_id,event_type,actor_user_id,idempotency_key,details)
  values(v_wo.id,'released',p_actor_user_id,p_idempotency_key||':audit:released',jsonb_build_object('plannedTransferId',v_plan_id,'shortageOverrideCount',v_shortage_count,'shopifyCall',false));
  return jsonb_build_object('alreadyReleased',false,'workOrderId',v_wo.id,'plannedTransferId',v_plan_id,'shortageOverrideCount',v_shortage_count);
end $$;

create or replace function public.cancel_mfg_work_order(
  p_actor_user_id bigint,p_work_order_id bigint,p_reason text,p_idempotency_key text
) returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare v_wo public.mfg_work_orders%rowtype;
begin
  if not public.mfg_actor_can(p_actor_user_id,'cancel') then raise exception 'manufacturing_permission_denied:cancel'; end if;
  if nullif(btrim(coalesce(p_reason,'')),'') is null then raise exception 'cancellation_reason_required'; end if;
  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is null then raise exception 'idempotency_key_required'; end if;
  select * into v_wo from public.mfg_work_orders where id=p_work_order_id for update;
  if not found then raise exception 'work_order_not_found'; end if;
  if v_wo.status='Cancelled' and v_wo.cancellation_idempotency_key=p_idempotency_key then return jsonb_build_object('alreadyCancelled',true,'workOrderId',v_wo.id); end if;
  if v_wo.status in ('In Production','Paused','Partially Completed') then raise exception 'started_work_requires_controlled_close'; end if;
  if v_wo.status in ('Completed','Closed') then raise exception 'completed_production_cannot_be_cancelled'; end if;
  if v_wo.status not in ('Draft','Released') then raise exception 'work_order_cannot_be_cancelled'; end if;
  if v_wo.status='Released' then
    update public.mfg_component_allocations set released_quantity=allocated_quantity-consumed_quantity,status='released',released_at=now()
    where work_order_id=v_wo.id and status in ('active','partially_consumed');
    update public.mfg_planned_transfers set status='cancelled',updated_at=now() where work_order_id=v_wo.id and status='planned';
  end if;
  update public.mfg_work_orders set status='Cancelled',cancelled_by=p_actor_user_id,cancelled_at=now(),cancellation_reason=btrim(p_reason),cancellation_idempotency_key=p_idempotency_key,updated_at=now() where id=v_wo.id;
  insert into public.mfg_status_history(work_order_id,from_status,to_status,reason,changed_by,idempotency_key)
  values(v_wo.id,v_wo.status,'Cancelled',btrim(p_reason),p_actor_user_id,p_idempotency_key||':status:cancelled');
  insert into public.mfg_audit_events(work_order_id,event_type,actor_user_id,idempotency_key,details)
  values(v_wo.id,'cancelled',p_actor_user_id,p_idempotency_key||':audit:cancelled',jsonb_build_object('previousStatus',v_wo.status,'reason',btrim(p_reason),'inventoryQuantityEffect',false));
  return jsonb_build_object('alreadyCancelled',false,'workOrderId',v_wo.id,'previousStatus',v_wo.status);
end $$;

create or replace function public.mfg_cost_availability(p_work_order_id bigint)
returns jsonb language sql stable security invoker set search_path='pg_catalog','public' as $$
  select case when exists(
    select 1 from public.mfg_component_allocations a join public.products p on p.id=a.component_product_id
    where a.work_order_id=p_work_order_id and coalesce(p.moving_average_cost,0)<=0
  ) then jsonb_build_object('available',false,'message','Cost unavailable — component cost source not configured')
  else jsonb_build_object('available',false,'message','Cost unavailable — no completion cost snapshot exists') end
$$;

do $$ declare t text; begin
  foreach t in array array[
    'mfg_feature_flags','mfg_role_permissions','mfg_user_permission_overrides','mfg_bom_versions','mfg_bom_version_components',
    'mfg_work_orders','mfg_work_order_lines','mfg_work_order_bom_snapshots','mfg_work_order_snapshot_components',
    'mfg_component_allocations','mfg_shortage_overrides','mfg_planned_transfers','mfg_planned_transfer_lines',
    'mfg_completion_events','mfg_component_consumption_events','mfg_finished_inventory_events','mfg_standard_labor_rules',
    'mfg_cost_snapshots','mfg_cost_snapshot_components','mfg_work_order_notes','mfg_status_history','mfg_audit_events'
  ] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on table public.%I from public,anon,authenticated',t);
    execute format('grant select,insert,update,delete on table public.%I to service_role',t);
  end loop;
end $$;

grant usage,select on all sequences in schema public to service_role;
revoke all on function public.mfg_actor_can(bigint,text) from public,anon,authenticated;
revoke all on function public.create_mfg_work_order_draft(bigint,bigint,text,jsonb,text,date,text,text) from public,anon,authenticated;
revoke all on function public.release_mfg_work_order(bigint,bigint,text,text) from public,anon,authenticated;
revoke all on function public.cancel_mfg_work_order(bigint,bigint,text,text) from public,anon,authenticated;
revoke all on function public.mfg_cost_availability(bigint) from public,anon,authenticated;
grant execute on function public.mfg_actor_can(bigint,text) to service_role;
grant execute on function public.create_mfg_work_order_draft(bigint,bigint,text,jsonb,text,date,text,text) to service_role;
grant execute on function public.release_mfg_work_order(bigint,bigint,text,text) to service_role;
grant execute on function public.cancel_mfg_work_order(bigint,bigint,text,text) to service_role;
grant execute on function public.mfg_cost_availability(bigint) to service_role;

comment on table public.mfg_planned_transfers is 'Non-inventory production plan. It is excluded from normal transfer/inbound inventory until actual good production promotes quantities.';
comment on table public.mfg_component_allocations is 'Manufacturing-only reservations. Signed availability is inventory balance quantity minus Shopify committed minus active manufacturing reservations.';
comment on function public.release_mfg_work_order(bigint,bigint,text,text) is 'Service-role-only atomic release; performs no Shopify or external network calls.';
