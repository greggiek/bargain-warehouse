create unique index if not exists mfg_bom_versions_one_draft_idx
  on public.mfg_bom_versions(source_bom_id) where status='draft';

create or replace function public.save_mfg_bom_draft(
  p_actor_user_id bigint,
  p_source_bom_version_id bigint,
  p_yield_quantity numeric,
  p_components jsonb,
  p_notes text,
  p_idempotency_key text
) returns jsonb language plpgsql security invoker set search_path='pg_catalog','public' as $$
declare
  v_source public.mfg_bom_versions%rowtype;
  v_draft public.mfg_bom_versions%rowtype;
  v_component jsonb;
  v_hash text;
  v_result jsonb;
begin
  if not public.mfg_actor_can(p_actor_user_id,'bom_admin') then raise exception 'manufacturing_permission_denied:bom_admin'; end if;
  if nullif(btrim(coalesce(p_idempotency_key,'')),'') is null then raise exception 'idempotency_key_required'; end if;
  select details->'result' into v_result from public.mfg_audit_events where idempotency_key=p_idempotency_key;
  if found then return v_result || jsonb_build_object('alreadySaved',true); end if;
  if p_yield_quantity is null or p_yield_quantity<=0 then raise exception 'yield_quantity_invalid'; end if;
  if jsonb_typeof(p_components)<>'array' or jsonb_array_length(p_components)=0 then raise exception 'bom_components_required'; end if;

  select * into v_source from public.mfg_bom_versions where id=p_source_bom_version_id for share;
  if not found then raise exception 'source_bom_version_not_found'; end if;
  for v_component in select value from jsonb_array_elements(p_components) loop
    if coalesce((v_component->>'productId')::bigint,0)=v_source.finished_product_id then raise exception 'finished_product_cannot_be_component'; end if;
    if coalesce((v_component->>'quantity')::numeric,0)<=0 then raise exception 'component_quantity_invalid'; end if;
    perform 1 from public.products where id=(v_component->>'productId')::bigint and active;
    if not found then raise exception 'component_product_inactive_or_missing'; end if;
  end loop;
  if (select count(*) from jsonb_array_elements(p_components)) <>
     (select count(distinct (value->>'productId')::bigint) from jsonb_array_elements(p_components)) then
    raise exception 'duplicate_bom_component';
  end if;

  select md5(string_agg((value->>'productId')||':'||(value->>'quantity')::numeric,'|' order by (value->>'productId')::bigint))
    into v_hash from jsonb_array_elements(p_components);
  select * into v_draft from public.mfg_bom_versions where source_bom_id=v_source.source_bom_id and status='draft' for update;
  if found then
    update public.mfg_bom_versions set yield_quantity=p_yield_quantity,component_hash=v_hash,notes=nullif(btrim(coalesce(p_notes,'')),'') where id=v_draft.id returning * into v_draft;
    delete from public.mfg_bom_version_components where bom_version_id=v_draft.id;
  else
    insert into public.mfg_bom_versions(source_bom_id,version_number,finished_product_id,yield_quantity,status,source_type,source_reference,component_hash,notes,created_by)
    values(v_source.source_bom_id,(select coalesce(max(version_number),0)+1 from public.mfg_bom_versions where source_bom_id=v_source.source_bom_id),v_source.finished_product_id,p_yield_quantity,'draft','bm_manual',v_source.source_reference,v_hash,nullif(btrim(coalesce(p_notes,'')),''),p_actor_user_id)
    returning * into v_draft;
  end if;
  insert into public.mfg_bom_version_components(bom_version_id,component_product_id,quantity_per_yield)
    select v_draft.id,(value->>'productId')::bigint,(value->>'quantity')::numeric from jsonb_array_elements(p_components);
  v_result=jsonb_build_object('draftVersionId',v_draft.id,'sourceBomVersionId',v_source.id,'versionNumber',v_draft.version_number,'status','draft','componentHash',v_hash,'componentCount',jsonb_array_length(p_components),'alreadySaved',false);
  insert into public.mfg_audit_events(event_type,actor_user_id,idempotency_key,details)
    values('bom_draft_saved',p_actor_user_id,p_idempotency_key,jsonb_build_object('result',v_result,'finishedProductId',v_source.finished_product_id));
  return v_result;
end $$;

revoke all on function public.save_mfg_bom_draft(bigint,bigint,numeric,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.save_mfg_bom_draft(bigint,bigint,numeric,jsonb,text,text) to service_role;
