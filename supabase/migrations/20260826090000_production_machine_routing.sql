-- Routes manufacturing work to the correct machine.
-- EMAG handles custom-door work orders. Nighthawk and Terminator handle stock-door BOM jobs.

alter table public.production_jobs
  add column if not exists machine_code text not null default 'NIGHTHAWK';

alter table public.production_work_orders
  add column if not exists machine_code text not null default 'EMAG';

alter table public.manufacturing_shopify_triggers
  add column if not exists machine_code text not null default 'EMAG';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'production_jobs_machine_code_check') then
    alter table public.production_jobs add constraint production_jobs_machine_code_check
      check (machine_code in ('NIGHTHAWK','TERMINATOR'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'production_work_orders_machine_code_check') then
    alter table public.production_work_orders add constraint production_work_orders_machine_code_check
      check (machine_code in ('EMAG','NIGHTHAWK','TERMINATOR'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'manufacturing_shopify_triggers_machine_code_check') then
    alter table public.manufacturing_shopify_triggers add constraint manufacturing_shopify_triggers_machine_code_check
      check (machine_code in ('EMAG','NIGHTHAWK','TERMINATOR'));
  end if;
end $$;

create or replace function public.start_v2_stock_production_job(
  p_destination_location_id bigint,
  p_lines jsonb,
  p_reference text,
  p_idempotency_key text,
  p_machine_code text,
  p_user_id bigint,
  p_user_name text
) returns jsonb
language plpgsql
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_job_id bigint; v_number text; v_location_id bigint; v_line record; v_component record;
  v_machine text := upper(trim(coalesce(p_machine_code,'')));
begin
  if v_machine not in ('NIGHTHAWK','TERMINATOR') then raise exception 'Stock door jobs must run on Nighthawk or Terminator'; end if;
  if p_destination_location_id is null then raise exception 'final destination is required'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines)=0 then raise exception 'add at least one finished door'; end if;
  if nullif(trim(coalesce(p_idempotency_key,'')),'') is null then raise exception 'idempotency key is required'; end if;
  select id into v_location_id from public.locations where active and code='730' order by id limit 1;
  if v_location_id is null then raise exception '730 Windham production location is not configured'; end if;
  if p_destination_location_id=v_location_id then raise exception 'choose a destination other than 730 Windham Rd'; end if;
  select id,job_number into v_job_id,v_number from public.production_jobs where idempotency_key=p_idempotency_key;
  if found then return jsonb_build_object('alreadyStarted',true,'jobId',v_job_id,'jobNumber',v_number); end if;
  if exists (select 1 from jsonb_to_recordset(p_lines) as x(bom_id bigint, quantity numeric) left join public.product_boms b on b.id=x.bom_id and b.active where x.bom_id is null or x.quantity is null or x.quantity<=0 or b.id is null) then raise exception 'each production line needs an active BOM and quantity above zero'; end if;
  if (select count(*) from jsonb_to_recordset(p_lines) as x(bom_id bigint, quantity numeric)) <> (select count(distinct bom_id) from jsonb_to_recordset(p_lines) as x(bom_id bigint, quantity numeric)) then raise exception 'each finished BOM can appear only once per job'; end if;

  insert into public.production_jobs(job_number,production_location_id,destination_location_id,reference,idempotency_key,machine_code,status,created_by_user_id,created_by_name)
  values('WO-'||to_char(clock_timestamp(),'YYYYMMDD-HH24MISSMS'),v_location_id,p_destination_location_id,nullif(trim(p_reference),''),p_idempotency_key,v_machine,'allocated',p_user_id,p_user_name)
  returning id,job_number into v_job_id,v_number;

  for v_line in select x.bom_id,x.quantity from jsonb_to_recordset(p_lines) as x(bom_id bigint, quantity numeric) order by x.bom_id loop
    insert into public.production_job_lines(job_id,bom_id,output_quantity) values(v_job_id,v_line.bom_id,v_line.quantity);
  end loop;

  for v_component in
    select c.component_product_id, sum(l.output_quantity*c.quantity_per_yield/b.yield_quantity) as needed
    from public.production_job_lines l join public.product_boms b on b.id=l.bom_id join public.product_bom_components c on c.bom_id=b.id
    where l.job_id=v_job_id group by c.component_product_id order by c.component_product_id
  loop
    insert into public.inventory_balances(product_id,location_id,quantity,allocated_quantity) values(v_component.component_product_id,v_location_id,0,0) on conflict(product_id,location_id) do nothing;
    update public.inventory_balances set allocated_quantity=allocated_quantity+v_component.needed,updated_at=now() where product_id=v_component.component_product_id and location_id=v_location_id;
  end loop;

  insert into public.activity_events(user_id,user_name,action_type,document_type,document_number,description,status,metadata)
  values(p_user_id,coalesce(nullif(trim(p_user_name),''),'Warehouse user'),'PRODUCTION_ALLOCATED','production',v_number,'Reserved 730 components for stock-door production on '||initcap(lower(v_machine)),'success',jsonb_build_object('jobId',v_job_id,'machineCode',v_machine,'lineCount',jsonb_array_length(p_lines),'destinationLocationId',p_destination_location_id));
  return jsonb_build_object('alreadyStarted',false,'jobId',v_job_id,'jobNumber',v_number,'machineCode',v_machine);
end
$function$;
