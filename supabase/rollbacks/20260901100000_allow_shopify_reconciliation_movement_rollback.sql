-- Rollback for 20260901100000_allow_shopify_reconciliation_movement.sql
-- Run only after confirming no shopify_reconciliation rows remain.
alter table public.inventory_movements
  drop constraint if exists inventory_movements_movement_type_check;
alter table public.inventory_movements
  add constraint inventory_movements_movement_type_check
  check (movement_type in (
    'opening_balance','purchase_receipt','transfer_ship','transfer_receive',
    'production_consume','production_complete','cycle_count','adjustment',
    'damage','return','allocation','allocation_release'
  ));
