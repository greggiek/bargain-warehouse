begin;

-- Rollback is intentionally blocked after a cross-store Manufacturing order has
-- been closed under the corrected rule. Historical close evidence is immutable.
do $$
begin
  if exists(
    select 1 from public.mfg_audit_events e
    where e.event_type='closed' and e.details->>'routeType'='cross_store'
  ) then raise exception 'rollback_blocked_cross_store_work_order_closed'; end if;
end $$;

-- Restore the preceding function from the applied migration if rollback is safe.
-- This file is paired for audit; production rollback must reapply the complete
-- definition from 20260902160000_manufacturing_native_transfer_handoff.sql.

rollback;
