alter table public.alerts
  add column if not exists telegram_status text default 'pending',
  add column if not exists telegram_error  text;
