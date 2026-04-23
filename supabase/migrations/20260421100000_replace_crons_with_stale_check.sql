-- Remove the 4 daily report cron jobs
select cron.unschedule('bosta-check-1-morning');
select cron.unschedule('bosta-check-2-midday');
select cron.unschedule('bosta-check-3-afternoon');
select cron.unschedule('bosta-check-4-eod');

-- Schedule stale order check daily at 12:30 Cairo (UTC+2 = 10:30 UTC)
select cron.schedule(
  'bosta-stale-check',
  '30 10 * * *',
  $job$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url' limit 1)
               || '/functions/v1/bosta-stale-check',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1)
    ),
    body    := '{}'::jsonb
  );
  $job$
);
