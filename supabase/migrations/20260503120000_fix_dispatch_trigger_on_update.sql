-- Replace INSERT-only trigger with INSERT OR UPDATE so dispatch fires after
-- order_details enrichment, not before. The webhook now inserts with
-- status='enriching' to hold dispatch, fetches order details, then updates
-- to status='pending' — this UPDATE is what fires dispatch.
--
-- WHEN clause can only reference NEW on a combined INSERT OR UPDATE trigger;
-- the dedup guard (skip if already pending) lives in the function body instead.
drop trigger if exists dispatch_alert_after_insert on public.alerts;

create or replace function public.dispatch_alert_on_insert()
returns trigger language plpgsql security definer as $$
declare
  project_url  text;
  service_key  text;
begin
  if new.status != 'pending' then return new; end if;
  -- On UPDATE, skip if status didn't actually change (avoids double-dispatch)
  if TG_OP = 'UPDATE' and old.status = 'pending' then return new; end if;

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

create trigger dispatch_alert_after_change
after insert or update on public.alerts
for each row
when (new.status = 'pending')
execute function public.dispatch_alert_on_insert();
