alter table public.cycle_count_lines
  add column if not exists review_status text not null default 'pending'
    check (review_status in ('pending','approved','recount_required','dismissed')),
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by_user_id bigint,
  add column if not exists reviewed_by_name text,
  add column if not exists review_note text,
  add column if not exists adjustment_movement_id bigint references public.inventory_movements(id);
create index if not exists cycle_count_lines_review_idx on public.cycle_count_lines(review_status,status);
create or replace function public.approve_v2_cycle_count_variance(p_line_id bigint,p_user_id bigint,p_user_name text,p_review_note text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_line public.cycle_count_lines%rowtype;v_run public.cycle_count_runs%rowtype;v_product public.products%rowtype;v_before numeric;v_after numeric;v_allocated numeric;v_delta numeric;v_movement_id bigint;v_note text:=nullif(trim(coalesce(p_review_note,'')),'');
begin
 select * into v_line from public.cycle_count_lines where id=p_line_id for update;
 if not found then raise exception 'cycle count line not found'; end if;
 if v_line.status<>'variance' then raise exception 'only a variance can be approved'; end if;
 if v_line.review_status<>'pending' then raise exception 'this variance was already reviewed'; end if;
 if v_line.counted_quantity is null then raise exception 'physical count is required'; end if;
 select * into v_run from public.cycle_count_runs where id=v_line.run_id for update;select * into v_product from public.products where id=v_line.product_id;if not found then raise exception 'product not found'; end if;
 select quantity,allocated_quantity into v_before,v_allocated from public.inventory_balances where product_id=v_line.product_id and location_id=v_run.location_id for update;
 if not found then insert into public.inventory_balances(product_id,location_id,quantity,allocated_quantity) values(v_line.product_id,v_run.location_id,0,0) on conflict(product_id,location_id) do nothing;select quantity,allocated_quantity into v_before,v_allocated from public.inventory_balances where product_id=v_line.product_id and location_id=v_run.location_id for update; end if;
 v_after:=v_line.counted_quantity;if v_after<v_allocated then raise exception 'cannot set on-hand below the % pieces already allocated',v_allocated;end if;v_delta:=v_after-v_before;
 update public.inventory_balances set quantity=v_after,updated_at=now() where product_id=v_line.product_id and location_id=v_run.location_id;
 insert into public.inventory_movements(product_id,location_id,movement_type,quantity_delta,quantity_before,quantity_after,unit_cost,reference_type,reference_id,reason,idempotency_key,performed_by_user_id,performed_by_name,metadata)
 values(v_line.product_id,v_run.location_id,'cycle_count',v_delta,v_before,v_after,v_product.moving_average_cost,'cycle_count','CC-'||v_line.id,'Approved daily cycle count','cycle-count-review-'||v_line.id,p_user_id,p_user_name,jsonb_build_object('cycleCountRunId',v_run.id,'cycleCountLineId',v_line.id,'countedQuantity',v_line.counted_quantity,'expectedQuantity',v_line.expected_quantity,'reviewNote',v_note)) returning id into v_movement_id;
 update public.cycle_count_lines set review_status='approved',reviewed_at=now(),reviewed_by_user_id=p_user_id,reviewed_by_name=p_user_name,review_note=v_note,adjustment_movement_id=v_movement_id where id=v_line.id;
 insert into public.activity_events(user_id,user_name,action_type,document_type,document_number,warehouse_id,description,status,metadata) values(p_user_id,coalesce(nullif(trim(p_user_name),''),'Warehouse manager'),'CYCLE_COUNT_APPROVED','cycle_count','CC-'||v_line.id,v_run.location_id,'Approved cycle count for '||v_product.sku,'success',jsonb_build_object('cycleCountLineId',v_line.id,'movementId',v_movement_id,'quantityBefore',v_before,'quantityAfter',v_after,'reviewNote',v_note));
 return jsonb_build_object('lineId',v_line.id,'movementId',v_movement_id,'quantityBefore',v_before,'quantityAfter',v_after,'quantityDelta',v_delta);
end;$$;
revoke all on function public.approve_v2_cycle_count_variance(bigint,bigint,text,text) from public,anon,authenticated;
grant execute on function public.approve_v2_cycle_count_variance(bigint,bigint,text,text) to service_role;