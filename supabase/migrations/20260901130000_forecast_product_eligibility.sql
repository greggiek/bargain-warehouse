create table if not exists public.product_forecast_eligibility(
 product_id bigint primary key references public.products(id) on delete cascade,
 forecast_eligible boolean not null,
 eligibility_type text not null check(eligibility_type in('stocked_product','special_order_product','manufactured_finished_good','raw_material_component','service','delivery_freight','labor','fee_deposit','custom_non_catalog','discontinued_historical','manual_exclusion')),
 reason text not null,updated_by text not null,updated_at timestamptz not null default now());
create table if not exists public.product_forecast_eligibility_reviews(
 product_id bigint primary key references public.products(id) on delete cascade,
 review_status text not null default 'pending' check(review_status in('pending','approved_eligible','approved_excluded')),
 suggested_type text,evidence jsonb not null default '{}'::jsonb,reviewed_by text,reviewed_at timestamptz,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now());
alter table public.product_shopify_sources add column if not exists source_product_type text,add column if not exists source_tracks_inventory boolean;
create index if not exists product_forecast_eligibility_excluded_idx on public.product_forecast_eligibility(forecast_eligible) where forecast_eligible=false;
revoke all on public.product_forecast_eligibility from public,anon,authenticated;
revoke all on public.product_forecast_eligibility_reviews from public,anon,authenticated;
grant select,insert,update on public.product_forecast_eligibility to service_role;
grant select,insert,update on public.product_forecast_eligibility_reviews to service_role;
insert into public.product_forecast_eligibility(product_id,forecast_eligible,eligibility_type,reason,updated_by)
select id,false,'delivery_freight','Delivery service charge; not a physical purchasable product. Explicitly approved for Forecast exclusion.','Greg Kleczka' from public.products where upper(btrim(sku))='DELIVERY'
on conflict(product_id) do update set forecast_eligible=excluded.forecast_eligible,eligibility_type=excluded.eligibility_type,reason=excluded.reason,updated_by=excluded.updated_by,updated_at=now();
insert into public.product_forecast_eligibility_reviews(product_id,review_status,suggested_type,evidence)
select id,'pending','special_order_product',jsonb_build_object('sku',sku,'title',name,'category',category,'note','Text match alone is insufficient; do not exclude automatically.') from public.products where upper(btrim(sku))='MISCDOORSKU'
on conflict(product_id) do nothing;
