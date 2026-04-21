create extension if not exists pg_net with schema extensions;

alter table public.alerts
  add column if not exists telegram_status text default 'pending',
  add column if not exists telegram_error  text;

create or replace function public.dispatch_alert_on_insert()
returns trigger language plpgsql security definer as $$
begin
  perform extensions.http_post(
    url     := current_setting('app.supabase_url') || '/functions/v1/dispatch-alert',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key')
    ),
    body    := jsonb_build_object('alert_id', new.id)
  );
  return new;
end;
$$;

create trigger dispatch_alert_after_insert
after insert on public.alerts
for each row execute function public.dispatch_alert_on_insert();
