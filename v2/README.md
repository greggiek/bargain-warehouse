# BM Warehouse V2

BM Warehouse V2 is an isolated rebuild that will run beside the current warehouse system during validation. It does not read from or write to Qoblex.

## Environments

- Supabase project: `fvzaewmyobgznncbkagh`
- Vercel project: `bm-warehouse-v2`
- Vercel root directory: `v2`

V1 remains unchanged until V2 passes parallel testing and a separately approved cutover.

## Local verification

```sh
cd v2
npm test
npm run check
```

## Configuration

Copy `.env.example` to a local environment file and supply the V2-only values. The service-role key is server-side only and must never be sent to browser code.

## Database

Apply the migrations in `supabase/migrations` to a fresh Supabase project. The foundation creates warehouse, location, user-access, product, vendor, inventory balance, immutable inventory movement, and activity event records. Inventory changes go through the atomic `post_inventory_movement` function.

The initial seed contains only the verified Bargain Moulding warehouse and location directory. It contains no products, balances, movements, or Qoblex identifiers.
