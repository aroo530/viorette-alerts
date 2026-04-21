alter table public.alerts
  add column if not exists order_details jsonb;
