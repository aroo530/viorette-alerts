create extension if not exists pg_cron schema extensions;

-- Cairo is UTC+2 (no DST), so subtract 2h for UTC schedule
-- 10:00 Cairo = 08:00 UTC
-- 12:30 Cairo = 10:30 UTC
-- 15:00 Cairo = 13:00 UTC
-- 17:00 Cairo = 15:00 UTC

select cron.schedule(
  'bosta-check-1-morning',
  '0 8 * * *',
  $job$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url' limit 1)
               || '/functions/v1/bosta-daily-report',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1)
    ),
    body    := '{"check":1}'::jsonb
  );
  $job$
);

select cron.schedule(
  'bosta-check-2-midday',
  '30 10 * * *',
  $job$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url' limit 1)
               || '/functions/v1/bosta-daily-report',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1)
    ),
    body    := '{"check":2}'::jsonb
  );
  $job$
);

select cron.schedule(
  'bosta-check-3-afternoon',
  '0 13 * * *',
  $job$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url' limit 1)
               || '/functions/v1/bosta-daily-report',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1)
    ),
    body    := '{"check":3}'::jsonb
  );
  $job$
);

select cron.schedule(
  'bosta-check-4-eod',
  '0 15 * * *',
  $job$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url' limit 1)
               || '/functions/v1/bosta-daily-report',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1)
    ),
    body    := '{"check":4}'::jsonb
  );
  $job$
);
