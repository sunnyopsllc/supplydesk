-- Inventory sync moves from hourly to once a day at 14:05 UTC (6:05 AM PST), five minutes after the
-- work-order sync (14:00 UTC) so the two don't save at the same moment. 60s call timeout because the
-- sync takes longer than pg_net's 5s default.
select cron.unschedule('sync-inventory-hourly') where exists (select 1 from cron.job where jobname = 'sync-inventory-hourly');
select cron.unschedule('sync-inventory-daily') where exists (select 1 from cron.job where jobname = 'sync-inventory-daily');
select cron.schedule(
  'sync-inventory-daily', '5 14 * * *',
  $$
  select net.http_post(
    url := 'https://gomprsflladmbebjahkq.supabase.co/functions/v1/sync-inventory',
    headers := jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000);
  $$);
