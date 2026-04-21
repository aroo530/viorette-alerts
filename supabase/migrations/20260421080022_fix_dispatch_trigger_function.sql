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
