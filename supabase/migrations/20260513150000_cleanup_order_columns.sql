alter table public.alerts drop column if exists order_details;

alter table public.bosta_orders
  drop column if exists state_code,
  drop column if exists state_value;
