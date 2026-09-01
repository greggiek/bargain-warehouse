-- Transactional, idempotent signed-balance restoration from a completed cache snapshot.
do $$
declare v_run uuid:=gen_random_uuid();v_count integer;v_backup integer;v_restored integer;v_checksum text;v_movements bigint;
begin
create temporary table intended on commit drop as
with completed as(select distinct on(store_key) store_key,id,started_at,completed_at from public.shopify_sync_jobs where job_type='inventory_snapshot' and status='completed' and completed_at is not null order by store_key,completed_at desc)
select ib.product_id,ib.location_id,ib.quantity quantity_before,ib.allocated_quantity allocated_before,ib.updated_at balance_updated_at_before,c.store_key,c.shopify_location_id,c.shopify_inventory_item_id,c.sku,c.on_hand_quantity cache_on_hand,c.available_quantity cache_available,c.committed_quantity cache_committed,c.source_updated_at cache_source_updated_at,c.last_synchronized_at cache_last_synchronized_at,j.id completed_job_id,j.started_at completed_started_at,j.completed_at completed_completed_at
from public.shopify_inventory_cache c join public.shopify_location_mappings m on m.store_key=c.store_key and m.shopify_location_id=c.shopify_location_id join public.inventory_balances ib on ib.product_id=c.product_id and ib.location_id=m.location_id join completed j on j.store_key=c.store_key
where c.product_id is not null and c.last_synchronized_at>=j.started_at and c.committed_quantity>=0 and(ib.quantity is distinct from c.on_hand_quantity or ib.allocated_quantity is distinct from c.committed_quantity);
select count(*) into v_count from intended;
select count(*) into v_movements from public.inventory_movements;
insert into public.inventory_signed_correction_runs(run_id,migration_name,status,intended_row_count,negative_on_hand_count,committed_gt_on_hand_count,minimum_on_hand,minimum_available,movements_before)
select v_run,'restore_signed_inventory_balances','backed_up',v_count,count(*) filter(where cache_on_hand<0),count(*) filter(where cache_committed>cache_on_hand),min(cache_on_hand),min(cache_on_hand-cache_committed),v_movements from intended;
insert into public.inventory_balance_signed_correction_backups(run_id,product_id,location_id,quantity_before,allocated_quantity_before,balance_updated_at_before,store_key,shopify_location_id,shopify_inventory_item_id,sku,cache_on_hand,cache_available,cache_committed,cache_source_updated_at,cache_last_synchronized_at,completed_snapshot_job_id,completed_snapshot_started_at,completed_snapshot_completed_at)
select v_run,product_id,location_id,quantity_before,allocated_before,balance_updated_at_before,store_key,shopify_location_id,shopify_inventory_item_id,sku,cache_on_hand,cache_available,cache_committed,cache_source_updated_at,cache_last_synchronized_at,completed_job_id,completed_started_at,completed_completed_at from intended;
select count(*),md5(string_agg(product_id||':'||location_id||':'||quantity_before||':'||allocated_quantity_before||':'||cache_on_hand||':'||cache_committed,'|' order by product_id,location_id)) into v_backup,v_checksum from public.inventory_balance_signed_correction_backups where run_id=v_run;
if v_backup<>v_count then raise exception 'Backup count differs from intended count';end if;
update public.inventory_balances ib set quantity=b.cache_on_hand,allocated_quantity=b.cache_committed,updated_at=now() from public.inventory_balance_signed_correction_backups b where b.run_id=v_run and ib.product_id=b.product_id and ib.location_id=b.location_id and(ib.quantity is distinct from b.cache_on_hand or ib.allocated_quantity is distinct from b.cache_committed);
get diagnostics v_restored=row_count;
if v_restored<>v_count then raise exception 'Restore count differs from intended count';end if;
update public.inventory_signed_correction_runs set status='completed',backup_row_count=v_backup,restored_row_count=v_restored,backup_checksum=v_checksum,movements_after=(select count(*) from public.inventory_movements),completed_at=now() where run_id=v_run;
end;$$;
