-- Run the Deposco work-order sync once daily at 6:00 AM PST (14:00 UTC).
select cron.unschedule('sync-work-orders-hourly')
where exists (
  select 1 from cron.job where jobname = 'sync-work-orders-hourly'
);

select cron.unschedule('sync-work-orders-daily')
where exists (
  select 1 from cron.job where jobname = 'sync-work-orders-daily'
);

select cron.schedule(
  'sync-work-orders-daily', '0 14 * * *',
  $$
  select net.http_post(
    url := 'https://gomprsflladmbebjahkq.supabase.co/functions/v1/sync-work-orders',
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
    body := '{}'::jsonb);
  $$
);
