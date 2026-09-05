alter table public.locations
  add column if not exists bm_os_location_id uuid;

create unique index if not exists locations_bm_os_location_id_key
  on public.locations (bm_os_location_id)
  where bm_os_location_id is not null;

comment on column public.locations.bm_os_location_id is
  'Permanent link to BM OS time_locations.id. Name matching may bootstrap this value once; authorization uses the stored ID afterward.';
