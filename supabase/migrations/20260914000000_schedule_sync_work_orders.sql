-- Runs the sync-work-orders Edge Function automatically every 6 hours, so
-- Supply Desk's work-order pills stay current with no one having to tap
-- anything. The service role key used to authorize the call lives in
-- Supabase Vault (vault.secrets, encrypted at rest) — never in this file.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select
  cron.schedule(
    'sync-work-orders-every-6h',
    '0 */6 * * *',
    $$
    select net.http_post(
      url := 'https://gomprsflladmbebjahkq.supabase.co/functions/v1/sync-work-orders',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
        )
      ),
      body := '{}'::jsonb
    );
    $$
  );
