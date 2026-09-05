begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

create table private.cycle_count_attempts (
  id bigint generated always as identity primary key,
  line_id bigint not null references public.cycle_count_lines(id) on delete restrict,
  run_id bigint not null references public.cycle_count_runs(id) on delete restrict,
  attempt_number integer not null check (attempt_number >= 1),
  expected_quantity numeric not null,
  counted_quantity numeric not null check (counted_quantity >= 0),
  counted_by_user_id bigint references public.app_users(id) on delete set null,
  counted_by_name text not null,
  counted_at timestamptz not null,
  note text,
  replaces_attempt_id bigint references private.cycle_count_attempts(id) on delete restrict,
  idempotency_key text not null unique,
  metadata jsonb not null default '{}'::jsonb,
  unique(line_id, attempt_number),
  unique(id, line_id)
);
create index cycle_count_attempts_line_created_idx on private.cycle_count_attempts(line_id,counted_at desc);
create index cycle_count_attempts_run_idx on private.cycle_count_attempts(run_id);
create index cycle_count_attempts_counter_idx on private.cycle_count_attempts(counted_by_user_id);
create index cycle_count_attempts_replaces_idx on private.cycle_count_attempts(replaces_attempt_id);
revoke all on table private.cycle_count_attempts from public,anon,authenticated;
grant select,insert on private.cycle_count_attempts to service_role;
revoke all on sequence private.cycle_count_attempts_id_seq from public,anon,authenticated;
grant usage,select on sequence private.cycle_count_attempts_id_seq to service_role;

create table private.cycle_count_operations (
  id bigint generated always as identity primary key,
  idempotency_key text not null unique,
  action_type text not null check (action_type in ('count_submit','recount_submit','recount_request','dismiss','approve')),
  line_id bigint not null references public.cycle_count_lines(id) on delete restrict,
  run_id bigint not null references public.cycle_count_runs(id) on delete restrict,
  actor_user_id bigint not null references public.app_users(id) on delete restrict,
  result jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((completed_at is null and result is null) or (completed_at is not null and result is not null))
);
create index cycle_count_operations_line_created_idx on private.cycle_count_operations(line_id,created_at desc);
create index cycle_count_operations_run_idx on private.cycle_count_operations(run_id);
create index cycle_count_operations_actor_idx on private.cycle_count_operations(actor_user_id);
revoke all on table private.cycle_count_operations from public,anon,authenticated;
grant select,insert,update on private.cycle_count_operations to service_role;
revoke all on sequence private.cycle_count_operations_id_seq from public,anon,authenticated;
grant usage,select on sequence private.cycle_count_operations_id_seq to service_role;

alter table public.cycle_count_lines add column current_attempt_id bigint;
alter table public.cycle_count_lines add constraint cycle_count_lines_current_attempt_fk
  foreign key(current_attempt_id,id) references private.cycle_count_attempts(id,line_id) on delete restrict;
create index cycle_count_lines_current_attempt_idx on public.cycle_count_lines(current_attempt_id,id);
alter table public.cycle_count_lines drop constraint cycle_count_lines_review_status_check;
alter table public.cycle_count_lines add constraint cycle_count_lines_review_status_check
  check(review_status in ('pending','not_required','approved','recount_required','dismissed'));
alter table public.cycle_count_lines add constraint cycle_count_lines_state_invariant check(
  (status='pending' and review_status in ('pending','recount_required')) or
  (status='counted' and review_status in ('pending','not_required')) or
  (status='variance' and review_status in ('pending','approved','dismissed'))
) not valid;

create unique index cycle_count_activity_idempotency_idx
  on public.activity_events(action_type,((metadata->>'idempotencyKey')))
  where metadata ? 'idempotencyKey';

create or replace function private.require_cycle_count_actor(p_actor_user_id bigint,p_location_id bigint,p_manager_required boolean)
returns public.app_users language plpgsql security invoker set search_path=pg_catalog,public,private as $$
declare v_actor public.app_users%rowtype;
begin
  select u.* into v_actor from public.app_users u
  join public.user_location_access ula on ula.user_id=u.id and ula.location_id=p_location_id
  where u.id=p_actor_user_id and u.active=true
    and u.role in ('warehouse','manager','admin','developer')
    and (not p_manager_required or (u.role in ('manager','admin','developer') and ula.can_manage=true));
  if not found then
    if p_manager_required then raise exception 'managed location access required'; end if;
    raise exception 'active location access required';
  end if;
  return v_actor;
end;$$;

create or replace function private.ensure_current_cycle_count_attempt(p_line_id bigint,p_idempotency_key text)
returns bigint language plpgsql security invoker set search_path=pg_catalog,public,private as $$
declare v_line public.cycle_count_lines%rowtype;v_attempt_id bigint;v_attempt_number integer;
begin
  select * into v_line from public.cycle_count_lines where id=p_line_id for update;
  if not found then raise exception 'cycle count line not found'; end if;
  if v_line.current_attempt_id is not null then return v_line.current_attempt_id; end if;
  if v_line.counted_quantity is null or v_line.counted_by_user_id is null or v_line.counted_at is null then
    raise exception 'existing count attribution is incomplete';
  end if;
  select coalesce(max(attempt_number),0)+1 into v_attempt_number from private.cycle_count_attempts where line_id=v_line.id;
  insert into private.cycle_count_attempts(line_id,run_id,attempt_number,expected_quantity,counted_quantity,counted_by_user_id,counted_by_name,counted_at,note,idempotency_key,metadata)
  values(v_line.id,v_line.run_id,v_attempt_number,v_line.expected_quantity,v_line.counted_quantity,v_line.counted_by_user_id,coalesce(nullif(trim(v_line.counted_by_name),''),'Warehouse user'),v_line.counted_at,v_line.note,p_idempotency_key||':preserved',jsonb_build_object('source','pre_pass_2b_projection'))
  returning id into v_attempt_id;
  update public.cycle_count_lines set current_attempt_id=v_attempt_id where id=v_line.id and current_attempt_id is null;
  return v_attempt_id;
end;$$;

create or replace function private.reconcile_v2_cycle_count_run(p_run_id bigint,p_terminal_actor_user_id bigint default null)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public,private as $$
declare v_run public.cycle_count_runs%rowtype;v_actor public.app_users%rowtype;v_pending integer;v_variances integer;v_result jsonb;
begin
  select * into v_run from public.cycle_count_runs where id=p_run_id for update;
  if not found then raise exception 'cycle count run not found'; end if;
  select count(*) filter(where status='pending'),count(*) filter(where status='variance' and review_status='pending')
  into v_pending,v_variances from public.cycle_count_lines where run_id=p_run_id;
  if v_pending>0 then
    update public.cycle_count_runs set status='open',reviewed_at=null,reviewed_by_user_id=null,reviewed_by_name=null where id=p_run_id;
  elsif v_variances>0 then
    update public.cycle_count_runs set status='ready_for_review',submitted_at=coalesce(submitted_at,now()),reviewed_at=null,reviewed_by_user_id=null,reviewed_by_name=null where id=p_run_id;
  else
    if p_terminal_actor_user_id is not null then
      select * into v_actor from public.app_users where id=p_terminal_actor_user_id and active=true;
      if not found then raise exception 'terminal actor not found or inactive'; end if;
    end if;
    update public.cycle_count_runs set status='reviewed',submitted_at=coalesce(submitted_at,now()),reviewed_at=now(),reviewed_by_user_id=v_actor.id,reviewed_by_name=v_actor.display_name where id=p_run_id;
  end if;
  select jsonb_build_object('runId',id,'status',status,'pendingLines',v_pending,'unresolvedVariances',v_variances,'reviewedAt',reviewed_at,'reviewedByUserId',reviewed_by_user_id,'reviewedByName',reviewed_by_name)
  into v_result from public.cycle_count_runs where id=p_run_id;
  return v_result;
end;$$;

revoke all on function private.require_cycle_count_actor(bigint,bigint,boolean) from public,anon,authenticated;
revoke all on function private.ensure_current_cycle_count_attempt(bigint,text) from public,anon,authenticated;
revoke all on function private.reconcile_v2_cycle_count_run(bigint,bigint) from public,anon,authenticated;
grant execute on function private.require_cycle_count_actor(bigint,bigint,boolean) to service_role;
grant execute on function private.ensure_current_cycle_count_attempt(bigint,text) to service_role;
grant execute on function private.reconcile_v2_cycle_count_run(bigint,bigint) to service_role;

create or replace function public.submit_v2_cycle_count_attempt(p_line_id bigint,p_counted_quantity numeric,p_note text,p_actor_user_id bigint,p_idempotency_key text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public,private as $$
declare v_run_id bigint;v_run public.cycle_count_runs%rowtype;v_line public.cycle_count_lines%rowtype;v_actor public.app_users%rowtype;v_op private.cycle_count_operations%rowtype;v_action text;v_prev bigint;v_attempt bigint;v_num integer;v_status text;v_review text;v_result jsonb;v_key text:=nullif(trim(coalesce(p_idempotency_key,'')),'');
begin
  if v_key is null then raise exception 'idempotency key is required'; end if;
  if p_counted_quantity is null or p_counted_quantity<0 then raise exception 'physical count must be zero or greater'; end if;
  select run_id into v_run_id from public.cycle_count_lines where id=p_line_id;
  if not found then raise exception 'cycle count line not found'; end if;
  select * into v_run from public.cycle_count_runs where id=v_run_id for update;
  if not found then raise exception 'cycle count run not found'; end if;
  select * into v_line from public.cycle_count_lines where id=p_line_id and run_id=v_run.id for update;
  if not found then raise exception 'cycle count line changed parent run'; end if;
  v_actor:=private.require_cycle_count_actor(p_actor_user_id,v_run.location_id,false);
  select * into v_op from private.cycle_count_operations where idempotency_key=v_key for update;
  if found then
    if v_op.action_type not in ('count_submit','recount_submit') or v_op.line_id<>v_line.id or v_op.run_id<>v_run.id or v_op.actor_user_id<>v_actor.id then raise exception 'idempotency key conflict'; end if;
    if v_op.completed_at is null or v_op.result is null then raise exception 'idempotent operation is incomplete'; end if;
    return v_op.result;
  end if;
  if v_line.status='pending' and v_line.review_status='pending' then v_action:='count_submit';
  elsif v_line.status='pending' and v_line.review_status='recount_required' then v_action:='recount_submit';
  else raise exception 'line is not accepting a count'; end if;
  insert into private.cycle_count_operations(idempotency_key,action_type,line_id,run_id,actor_user_id) values(v_key,v_action,v_line.id,v_run.id,v_actor.id) returning * into v_op;
  v_prev:=v_line.current_attempt_id;
  select coalesce(max(attempt_number),0)+1 into v_num from private.cycle_count_attempts where line_id=v_line.id;
  insert into private.cycle_count_attempts(line_id,run_id,attempt_number,expected_quantity,counted_quantity,counted_by_user_id,counted_by_name,counted_at,note,replaces_attempt_id,idempotency_key,metadata)
  values(v_line.id,v_run.id,v_num,v_line.expected_quantity,p_counted_quantity,v_actor.id,v_actor.display_name,now(),nullif(trim(coalesce(p_note,'')),''),v_prev,v_key,jsonb_build_object('actionType',v_action)) returning id into v_attempt;
  if p_counted_quantity=v_line.expected_quantity then v_status:='counted';v_review:='not_required'; else v_status:='variance';v_review:='pending'; end if;
  update public.cycle_count_lines set counted_quantity=p_counted_quantity,counted_by_user_id=v_actor.id,counted_by_name=v_actor.display_name,counted_at=now(),note=nullif(trim(coalesce(p_note,'')),''),status=v_status,review_status=v_review,reviewed_at=null,reviewed_by_user_id=null,reviewed_by_name=null,review_note=null,adjustment_movement_id=null,current_attempt_id=v_attempt where id=v_line.id;
  v_result:=jsonb_build_object('lineId',v_line.id,'runId',v_run.id,'actionType',v_action,'attemptId',v_attempt,'attemptNumber',v_num,'replacesAttemptId',v_prev,'countedQuantity',p_counted_quantity,'variance',p_counted_quantity-v_line.expected_quantity,'status',v_status,'reviewStatus',v_review,'run',private.reconcile_v2_cycle_count_run(v_run.id,null));
  insert into public.activity_events(user_id,user_name,action_type,document_type,document_number,warehouse_id,description,status,metadata)
  values(v_actor.id,v_actor.display_name,case when v_action='recount_submit' then 'CYCLE_COUNT_RECOUNT_SUBMITTED' else 'CYCLE_COUNT_COUNT_SUBMITTED' end,'cycle_count','CC-'||v_line.id,v_run.location_id,case when v_action='recount_submit' then 'Submitted replacement cycle count' else 'Submitted cycle count' end,'success',jsonb_build_object('idempotencyKey',v_key,'cycleCountRunId',v_run.id,'cycleCountLineId',v_line.id,'actionType',v_action,'attemptId',v_attempt,'attemptNumber',v_num,'replacesAttemptId',v_prev,'expectedQuantity',v_line.expected_quantity,'countedQuantity',p_counted_quantity,'actorUserId',v_actor.id,'actorName',v_actor.display_name,'outcomeStatus',v_status,'outcomeReviewStatus',v_review));
  update private.cycle_count_operations set result=v_result,completed_at=now() where id=v_op.id;
  return v_result;
end;$$;

create or replace function public.request_v2_cycle_count_recount(p_line_id bigint,p_actor_user_id bigint,p_reason text,p_idempotency_key text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public,private as $$
declare v_run_id bigint;v_run public.cycle_count_runs%rowtype;v_line public.cycle_count_lines%rowtype;v_actor public.app_users%rowtype;v_op private.cycle_count_operations%rowtype;v_attempt bigint;v_result jsonb;v_reason text:=nullif(trim(coalesce(p_reason,'')),'');v_key text:=nullif(trim(coalesce(p_idempotency_key,'')),'');
begin
  if v_reason is null then raise exception 'recount reason is required'; end if;if v_key is null then raise exception 'idempotency key is required'; end if;
  select run_id into v_run_id from public.cycle_count_lines where id=p_line_id;if not found then raise exception 'cycle count line not found';end if;
  select * into v_run from public.cycle_count_runs where id=v_run_id for update;if not found then raise exception 'cycle count run not found';end if;
  select * into v_line from public.cycle_count_lines where id=p_line_id and run_id=v_run.id for update;if not found then raise exception 'cycle count line changed parent run';end if;
  v_actor:=private.require_cycle_count_actor(p_actor_user_id,v_run.location_id,true);
  select * into v_op from private.cycle_count_operations where idempotency_key=v_key for update;
  if found then if v_op.action_type<>'recount_request' or v_op.line_id<>v_line.id or v_op.run_id<>v_run.id or v_op.actor_user_id<>v_actor.id then raise exception 'idempotency key conflict';end if;if v_op.completed_at is null or v_op.result is null then raise exception 'idempotent operation is incomplete';end if;return v_op.result;end if;
  if v_line.status<>'variance' or v_line.review_status<>'pending' then raise exception 'only an unresolved variance may be recounted';end if;
  insert into private.cycle_count_operations(idempotency_key,action_type,line_id,run_id,actor_user_id) values(v_key,'recount_request',v_line.id,v_run.id,v_actor.id) returning * into v_op;
  v_attempt:=private.ensure_current_cycle_count_attempt(v_line.id,v_key);
  update public.cycle_count_lines set status='pending',review_status='recount_required',reviewed_at=null,reviewed_by_user_id=null,reviewed_by_name=null,review_note=v_reason where id=v_line.id;
  v_result:=jsonb_build_object('lineId',v_line.id,'runId',v_run.id,'preservedAttemptId',v_attempt,'status','pending','reviewStatus','recount_required','run',private.reconcile_v2_cycle_count_run(v_run.id,null));
  insert into public.activity_events(user_id,user_name,action_type,document_type,document_number,warehouse_id,description,status,metadata) values(v_actor.id,v_actor.display_name,'CYCLE_COUNT_RECOUNT_REQUESTED','cycle_count','CC-'||v_line.id,v_run.location_id,'Requested cycle count recount','success',jsonb_build_object('idempotencyKey',v_key,'cycleCountRunId',v_run.id,'cycleCountLineId',v_line.id,'preservedAttemptId',v_attempt,'requestingManagerUserId',v_actor.id,'requestingManagerName',v_actor.display_name,'reason',v_reason));
  update private.cycle_count_operations set result=v_result,completed_at=now() where id=v_op.id;return v_result;
end;$$;

create or replace function public.dismiss_v2_cycle_count_variance(p_line_id bigint,p_actor_user_id bigint,p_reason text,p_idempotency_key text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public,private as $$
declare v_run_id bigint;v_run public.cycle_count_runs%rowtype;v_line public.cycle_count_lines%rowtype;v_actor public.app_users%rowtype;v_op private.cycle_count_operations%rowtype;v_attempt bigint;v_result jsonb;v_reason text:=nullif(trim(coalesce(p_reason,'')),'');v_key text:=nullif(trim(coalesce(p_idempotency_key,'')),'');
begin
  if v_reason is null then raise exception 'dismiss reason is required';end if;if v_key is null then raise exception 'idempotency key is required';end if;
  select run_id into v_run_id from public.cycle_count_lines where id=p_line_id;if not found then raise exception 'cycle count line not found';end if;
  select * into v_run from public.cycle_count_runs where id=v_run_id for update;if not found then raise exception 'cycle count run not found';end if;
  select * into v_line from public.cycle_count_lines where id=p_line_id and run_id=v_run.id for update;if not found then raise exception 'cycle count line changed parent run';end if;
  v_actor:=private.require_cycle_count_actor(p_actor_user_id,v_run.location_id,true);
  select * into v_op from private.cycle_count_operations where idempotency_key=v_key for update;
  if found then if v_op.action_type<>'dismiss' or v_op.line_id<>v_line.id or v_op.run_id<>v_run.id or v_op.actor_user_id<>v_actor.id then raise exception 'idempotency key conflict';end if;if v_op.completed_at is null or v_op.result is null then raise exception 'idempotent operation is incomplete';end if;return v_op.result;end if;
  if v_line.status<>'variance' or v_line.review_status<>'pending' or v_line.adjustment_movement_id is not null then raise exception 'only an unresolved unadjusted variance may be dismissed';end if;
  insert into private.cycle_count_operations(idempotency_key,action_type,line_id,run_id,actor_user_id) values(v_key,'dismiss',v_line.id,v_run.id,v_actor.id) returning * into v_op;
  v_attempt:=private.ensure_current_cycle_count_attempt(v_line.id,v_key);
  update public.cycle_count_lines set review_status='dismissed',reviewed_at=now(),reviewed_by_user_id=v_actor.id,reviewed_by_name=v_actor.display_name,review_note=v_reason where id=v_line.id;
  v_result:=jsonb_build_object('lineId',v_line.id,'runId',v_run.id,'attemptId',v_attempt,'reviewStatus','dismissed','inventoryChanged',false,'run',private.reconcile_v2_cycle_count_run(v_run.id,v_actor.id));
  insert into public.activity_events(user_id,user_name,action_type,document_type,document_number,warehouse_id,description,status,metadata) values(v_actor.id,v_actor.display_name,'CYCLE_COUNT_DISMISSED','cycle_count','CC-'||v_line.id,v_run.location_id,'Dismissed cycle count variance','success',jsonb_build_object('idempotencyKey',v_key,'cycleCountRunId',v_run.id,'cycleCountLineId',v_line.id,'attemptId',v_attempt,'managerUserId',v_actor.id,'managerName',v_actor.display_name,'reason',v_reason,'inventoryChanged',false));
  update private.cycle_count_operations set result=v_result,completed_at=now() where id=v_op.id;return v_result;
end;$$;

create or replace function public.approve_v2_cycle_count_variance(p_line_id bigint,p_actor_user_id bigint,p_actor_name text,p_review_note text,p_idempotency_key text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public,private as $$
declare v_run_id bigint;v_run public.cycle_count_runs%rowtype;v_line public.cycle_count_lines%rowtype;v_actor public.app_users%rowtype;v_product public.products%rowtype;v_op private.cycle_count_operations%rowtype;v_attempt bigint;v_before numeric;v_after numeric;v_allocated numeric;v_delta numeric;v_movement bigint;v_result jsonb;v_note text:=nullif(trim(coalesce(p_review_note,'')),'');v_key text:=nullif(trim(coalesce(p_idempotency_key,'')),'');
begin
  -- p_actor_name is compatibility-only. Authorization and attribution use v_actor loaded from the database.
  if v_key is null then raise exception 'idempotency key is required';end if;
  select run_id into v_run_id from public.cycle_count_lines where id=p_line_id;if not found then raise exception 'cycle count line not found';end if;
  select * into v_run from public.cycle_count_runs where id=v_run_id for update;if not found then raise exception 'cycle count run not found';end if;
  select * into v_line from public.cycle_count_lines where id=p_line_id and run_id=v_run.id for update;if not found then raise exception 'cycle count line changed parent run';end if;
  v_actor:=private.require_cycle_count_actor(p_actor_user_id,v_run.location_id,true);
  select * into v_op from private.cycle_count_operations where idempotency_key=v_key for update;
  if found then if v_op.action_type<>'approve' or v_op.line_id<>v_line.id or v_op.run_id<>v_run.id or v_op.actor_user_id<>v_actor.id then raise exception 'idempotency key conflict';end if;if v_op.completed_at is null or v_op.result is null then raise exception 'idempotent operation is incomplete';end if;return v_op.result;end if;
  if v_line.status<>'variance' or v_line.review_status<>'pending' or v_line.counted_quantity is null or v_line.adjustment_movement_id is not null then raise exception 'only an unresolved unadjusted variance may be approved';end if;
  insert into private.cycle_count_operations(idempotency_key,action_type,line_id,run_id,actor_user_id) values(v_key,'approve',v_line.id,v_run.id,v_actor.id) returning * into v_op;
  v_attempt:=private.ensure_current_cycle_count_attempt(v_line.id,v_key);
  select * into v_product from public.products where id=v_line.product_id;if not found then raise exception 'product not found';end if;
  -- Inventory balance is locked only after parent run and line.
  insert into public.inventory_balances(product_id,location_id,quantity,allocated_quantity) values(v_line.product_id,v_run.location_id,0,0) on conflict(product_id,location_id) do nothing;
  select quantity,allocated_quantity into v_before,v_allocated from public.inventory_balances where product_id=v_line.product_id and location_id=v_run.location_id for update;
  v_after:=v_line.counted_quantity;if v_after<v_allocated then raise exception 'cannot set on-hand below the % pieces already allocated',v_allocated;end if;v_delta:=v_after-v_before;
  update public.inventory_balances set quantity=v_after,updated_at=now() where product_id=v_line.product_id and location_id=v_run.location_id;
  insert into public.inventory_movements(product_id,location_id,movement_type,quantity_delta,quantity_before,quantity_after,unit_cost,reference_type,reference_id,reason,idempotency_key,performed_by_user_id,performed_by_name,metadata)
  values(v_line.product_id,v_run.location_id,'cycle_count',v_delta,v_before,v_after,v_product.moving_average_cost,'cycle_count','CC-'||v_line.id,'Approved daily cycle count','cycle-count-review-'||v_key,v_actor.id,v_actor.display_name,jsonb_build_object('idempotencyKey',v_key,'cycleCountRunId',v_run.id,'cycleCountLineId',v_line.id,'attemptId',v_attempt,'countedQuantity',v_line.counted_quantity,'expectedQuantity',v_line.expected_quantity,'reviewNote',v_note)) returning id into v_movement;
  update public.cycle_count_lines set review_status='approved',reviewed_at=now(),reviewed_by_user_id=v_actor.id,reviewed_by_name=v_actor.display_name,review_note=v_note,adjustment_movement_id=v_movement where id=v_line.id;
  v_result:=jsonb_build_object('lineId',v_line.id,'runId',v_run.id,'attemptId',v_attempt,'movementId',v_movement,'quantityBefore',v_before,'quantityAfter',v_after,'quantityDelta',v_delta,'inventoryChanged',true,'run',private.reconcile_v2_cycle_count_run(v_run.id,v_actor.id));
  insert into public.activity_events(user_id,user_name,action_type,document_type,document_number,warehouse_id,description,status,metadata) values(v_actor.id,v_actor.display_name,'CYCLE_COUNT_APPROVED','cycle_count','CC-'||v_line.id,v_run.location_id,'Approved cycle count for '||v_product.sku,'success',jsonb_build_object('idempotencyKey',v_key,'cycleCountRunId',v_run.id,'cycleCountLineId',v_line.id,'attemptId',v_attempt,'movementId',v_movement,'quantityBefore',v_before,'quantityAfter',v_after,'reviewNote',v_note,'managerUserId',v_actor.id,'managerName',v_actor.display_name,'inventoryChanged',true));
  update private.cycle_count_operations set result=v_result,completed_at=now() where id=v_op.id;return v_result;
end;$$;

revoke all on function public.submit_v2_cycle_count_attempt(bigint,numeric,text,bigint,text) from public,anon,authenticated;
revoke all on function public.request_v2_cycle_count_recount(bigint,bigint,text,text) from public,anon,authenticated;
revoke all on function public.dismiss_v2_cycle_count_variance(bigint,bigint,text,text) from public,anon,authenticated;
revoke all on function public.approve_v2_cycle_count_variance(bigint,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.submit_v2_cycle_count_attempt(bigint,numeric,text,bigint,text) to service_role;
grant execute on function public.request_v2_cycle_count_recount(bigint,bigint,text,text) to service_role;
grant execute on function public.dismiss_v2_cycle_count_variance(bigint,bigint,text,text) to service_role;
grant execute on function public.approve_v2_cycle_count_variance(bigint,bigint,text,text,text) to service_role;

commit;
