-- Only dispatch when the alert actually needs notification
create or replace function public.dispatch_alert_on_insert()
returns trigger language plpgsql security definer as $$
declare
  project_url  text;
  service_key  text;
begin
  if new.status != 'pending' then return new; end if;

  select decrypted_secret into project_url from vault.decrypted_secrets where name = 'project_url'  limit 1;
  select decrypted_secret into service_key from vault.decrypted_secrets where name = 'service_role_key' limit 1;

  perform net.http_post(
    url     := project_url || '/functions/v1/dispatch-alert',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || service_key
    ),
    body    := jsonb_build_object('alert_id', new.id)
  );
  return new;
end;
$$;
