-- Work-order sync moves from every 6 hours to hourly (at :30, offset from the inventory sync)
-- so "requested" work orders entered in Supply Desk flip to real Deposco work orders sooner.
select cron.unschedule('sync-work-orders-every-6h') where exists (select 1 from cron.job where jobname = 'sync-work-orders-every-6h');
select cron.schedule(
  'sync-work-orders-hourly', '30 * * * *',
  $$
  select net.http_post(
    url := 'https://gomprsflladmbebjahkq.supabase.co/functions/v1/sync-work-orders',
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
    body := '{}'::jsonb);
  $$);
