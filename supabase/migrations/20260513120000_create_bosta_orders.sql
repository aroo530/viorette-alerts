create table if not exists public.bosta_orders (
  id                    uuid primary key default gen_random_uuid(),
  bosta_id              text unique not null,
  tracking_number       text not null,
  business_reference    text,
  state_code            int,
  state_value           text,
  type_code             int,
  type_value            text,
  cod                   numeric,
  shipment_fees         numeric,
  attempts_count        int,
  last_exception_code   int,
  last_exception_reason text,
  receiver_name         text,
  receiver_phone        text,
  weight                numeric,
  package_type          text,
  items_count           int,
  scheduled_at          timestamptz,
  collected_at          timestamptz,
  bosta_created_at      timestamptz,
  bosta_updated_at      timestamptz,
  synced_at             timestamptz default now()
);

create index if not exists idx_bosta_orders_tracking on public.bosta_orders(tracking_number);
create index if not exists idx_bosta_orders_state    on public.bosta_orders(state_code);

alter table public.alerts
  add column if not exists order_id uuid references public.bosta_orders(id);

create index if not exists idx_alerts_order_id on public.alerts(order_id);
