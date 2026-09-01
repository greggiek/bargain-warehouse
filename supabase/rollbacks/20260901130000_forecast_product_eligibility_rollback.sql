delete from public.product_forecast_eligibility_reviews where product_id in(select id from public.products where upper(btrim(sku))='MISCDOORSKU');
delete from public.product_forecast_eligibility where product_id in(select id from public.products where upper(btrim(sku))='DELIVERY');
drop index if exists public.product_forecast_eligibility_excluded_idx;
drop table if exists public.product_forecast_eligibility_reviews;
drop table if exists public.product_forecast_eligibility;
alter table public.product_shopify_sources drop column if exists source_product_type,drop column if exists source_tracks_inventory;
