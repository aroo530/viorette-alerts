select cron.schedule(
  'bosta-webhook-miss-check',
  '0 10-16 * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url' limit 1)
               || '/functions/v1/bosta-webhook-miss',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key' limit 1)
    ),
    body    := '{}'::jsonb
  );
  $$
);
