drop index if exists public.locations_bm_os_location_id_key;

alter table public.locations
  drop column if exists bm_os_location_id;
