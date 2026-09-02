-- Trigger functions do not require caller EXECUTE privileges, but explicitly
-- remove PostgreSQL's default PUBLIC grant so every Manufacturing write path
-- remains service-role-only when inspected.
revoke all on function public.enqueue_mfg_shopify_inventory_adjustment() from public,anon,authenticated;
grant execute on function public.enqueue_mfg_shopify_inventory_adjustment() to service_role;
