# Supply Desk

Inventory, vendor, and work-order tracker for Better Days Co., built as a single static page backed by Supabase.

**Live site:** https://sunnyopsllc.github.io/supplydesk/
**Full handoff / architecture doc:** see the project owner for the current link, or ask Claude to regenerate one from this repo.

## What it is

One HTML/JS file (`index.html`) that talks directly to a Supabase project — no build step, no server of its own. Sign in, and every edit (inventory counts, vendors, purchase orders) saves live and syncs instantly across every open tab and device via Supabase Realtime.

It also keeps itself in sync with [Deposco](https://developer.deposco.com) (the 3PL's WMS): open work orders pull in automatically every 6 hours, or on demand from the "Sync work orders" button on the Dashboard.

## Stack

- **Frontend:** plain HTML/CSS/JS, [`@supabase/supabase-js`](https://github.com/supabase/supabase-js) loaded from CDN. Deployed as-is via GitHub Pages.
- **Database:** Supabase Postgres — a single `app_state` table (`id`, `data jsonb`, `updated_at`) holds the whole app state. Row Level Security restricts read/write to the `authenticated` role.
- **Auth:** Supabase Auth, email + password.
- **Background sync:** a Supabase Edge Function (`supabase/functions/sync-work-orders`) pulls open work orders from Deposco's API and writes them into `app_state`, triggered by the in-app button or by a `pg_cron` job every 6 hours.

## Project structure

```
index.html                              the whole app
supabase/
  config.toml                           project config, linked to ref gomprsflladmbebjahkq
  functions/
    sync-work-orders/index.ts           pulls open work orders from Deposco, updates app_state
  migrations/
    20260914000000_schedule_sync_work_orders.sql   pg_cron job that runs the sync every 6h
```

## Local development

There's no build step — `index.html` is servable as-is:

```bash
python3 -m http.server 8080
```

It points at the production Supabase project by default (`SUPABASE_URL` / publishable key are hardcoded near the top of the `<script>` — the publishable key is meant to be public, it's not a secret). Point it at a different project by editing those two constants.

## Deploying

Pushing to `main` redeploys the site automatically via GitHub Pages — no separate build/deploy step for `index.html`.

The Supabase side (Edge Functions, migrations) deploys separately, via the [Supabase CLI](https://supabase.com/docs/guides/cli):

```bash
supabase login                                          # or export SUPABASE_ACCESS_TOKEN
supabase link --project-ref gomprsflladmbebjahkq
supabase functions deploy sync-work-orders --project-ref gomprsflladmbebjahkq
```

Deposco credentials the function needs are stored as **function secrets**, not in this repo:

```bash
supabase secrets set --project-ref gomprsflladmbebjahkq \
  DEPOSCO_CLIENT_ID=... DEPOSCO_CLIENT_SECRET=... DEPOSCO_REFRESH_TOKEN=...
```

Applying a new migration (schema changes, cron jobs) needs a direct database connection (`db_password` from the project's Settings → Database) — this repo intentionally never commits that password or the Supabase `service_role` key. The scheduled sync's bearer credential lives encrypted in **Supabase Vault**, referenced by name from the migration SQL, never as a literal.

## What's not in this repo

- Deposco API credentials, the Supabase `service_role` key, and the database password — all local-only, never committed.
- A full operational handoff doc (architecture rationale, current Deposco integration status, pending work) — kept outside the repo since it references live credentials and internal context.
