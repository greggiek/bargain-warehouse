-- Roll back the latest completed signed-inventory correction.
begin;
do $$
declare v_run uuid;
begin
select run_id into v_run from public.inventory_signed_correction_runs where status='completed' order by completed_at desc limit 1;
if v_run is null then raise exception 'No completed signed-inventory correction found';end if;
update public.inventory_balances ib set quantity=b.quantity_before,allocated_quantity=b.allocated_quantity_before,updated_at=b.balance_updated_at_before
from public.inventory_balance_signed_correction_backups b where b.run_id=v_run and ib.product_id=b.product_id and ib.location_id=b.location_id;
update public.inventory_signed_correction_runs set status='rolled_back' where run_id=v_run;
end;$$;
alter table public.inventory_balances drop constraint if exists inventory_balances_allocation_check;
alter table public.inventory_balances add constraint inventory_balances_allocation_check check(
 allocated_quantity>=0 and ((quantity<0 and allocated_quantity=0) or (quantity>=0 and allocated_quantity<=quantity)));
commit;
-- Reapply 20260901101500_safe_shopify_operational_reconciliation.sql to restore its clamped sync function if a full code rollback is required.
