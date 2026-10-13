-- Runs the sync-inventory Edge Function every hour so on-hand quantities in
-- Supply Desk track Deposco without anyone tapping anything. Authorized with
-- the service role key stored in Supabase Vault (same as sync-work-orders).

select
  cron.schedule(
    'sync-inventory-hourly',
    '0 * * * *',
    $$
    select net.http_post(
      url := 'https://gomprsflladmbebjahkq.supabase.co/functions/v1/sync-inventory',
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
