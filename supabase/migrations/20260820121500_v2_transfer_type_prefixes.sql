-- Use distinct prefixes for the two V2 transfer flows. Existing records are intentionally left unchanged.
do $$
declare v_sql text;
begin
  select pg_get_functiondef(p.oid) into v_sql
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'create_v2_transfer';
  if v_sql is null then raise exception 'create_v2_transfer is missing'; end if;
  v_sql := replace(
    v_sql,
    'values(''TR-''||to_char(clock_timestamp(),''YYYYMMDD-HH24MISSMS''),p_from,p_to,''draft'',p_user,p_name)',
    'values(''MT-''||to_char(clock_timestamp(),''YYYYMMDD-HH24MISSMS''),p_from,p_to,''draft'',p_user,p_name)'
  );
  if position('MT-' in v_sql) = 0 then raise exception 'material transfer prefix update failed'; end if;
  execute v_sql;

  select pg_get_functiondef(p.oid) into v_sql
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'complete_v2_production_job';
  if v_sql is null then raise exception 'complete_v2_production_job is missing'; end if;
  v_sql := replace(
    v_sql,
    'values(''TR-''||to_char(clock_timestamp(),''YYYYMMDD-HH24MISSMS''),v_job.production_location_id,v_job.destination_location_id,''allocated'',p_user_id,p_user_name)',
    'values(''DT-''||to_char(clock_timestamp(),''YYYYMMDD-HH24MISSMS''),v_job.production_location_id,v_job.destination_location_id,''allocated'',p_user_id,p_user_name)'
  );
  if position('DT-' in v_sql) = 0 then raise exception 'door transfer prefix update failed'; end if;
  execute v_sql;

  -- Preserve the same numbering for the original single-line production workflow.
  select pg_get_functiondef(p.oid) into v_sql
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'complete_v2_production_work_order';
  if v_sql is null then raise exception 'complete_v2_production_work_order is missing'; end if;
  v_sql := replace(
    v_sql,
    'values(''TR-''||to_char(clock_timestamp(),''YYYYMMDD-HH24MISSMS''),v_work.production_location_id,v_work.destination_location_id,''allocated'',p_user_id,p_user_name)',
    'values(''DT-''||to_char(clock_timestamp(),''YYYYMMDD-HH24MISSMS''),v_work.production_location_id,v_work.destination_location_id,''allocated'',p_user_id,p_user_name)'
  );
  if position('DT-' in v_sql) = 0 then raise exception 'door work order prefix update failed'; end if;
  execute v_sql;
end $$;
