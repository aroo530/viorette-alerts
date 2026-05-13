-- Backfill bosta_orders from alerts.order_details and link order_id back
with inserted as (
  insert into public.bosta_orders (
    bosta_id,
    tracking_number,
    business_reference,
    state_code,
    state_value,
    type_code,
    type_value,
    cod,
    shipment_fees,
    attempts_count,
    last_exception_code,
    last_exception_reason,
    receiver_name,
    receiver_phone,
    weight,
    package_type,
    items_count,
    scheduled_at,
    collected_at,
    bosta_created_at,
    bosta_updated_at,
    synced_at
  )
  select distinct on ((order_details->>'bosta_id'))
    order_details->>'bosta_id',
    order_details->>'tracking_number',
    order_details->>'business_reference',
    (order_details->>'state_code')::int,
    order_details->>'state_value',
    (order_details->>'type_code')::int,
    order_details->>'type_value',
    (order_details->>'cod')::numeric,
    (order_details->>'shipment_fees')::numeric,
    (order_details->>'attempts_count')::int,
    (order_details->>'last_exception_code')::int,
    order_details->>'last_exception_reason',
    order_details->>'receiver_name',
    order_details->>'receiver_phone',
    (order_details->>'weight')::numeric,
    order_details->>'package_type',
    (order_details->>'items_count')::int,
    case when order_details->>'scheduled_at' ~ '^\d{4}-' then (order_details->>'scheduled_at')::timestamptz
         when order_details->>'scheduled_at' is not null then to_timestamp(order_details->>'scheduled_at', 'Dy Mon DD YYYY HH24:MI:SS "GMT+0000 (Coordinated Universal Time)"')
    end,
    case when order_details->>'collected_at' ~ '^\d{4}-' then (order_details->>'collected_at')::timestamptz
         when order_details->>'collected_at' is not null then to_timestamp(order_details->>'collected_at', 'Dy Mon DD YYYY HH24:MI:SS "GMT+0000 (Coordinated Universal Time)"')
    end,
    case when order_details->>'created_at' ~ '^\d{4}-' then (order_details->>'created_at')::timestamptz
         when order_details->>'created_at' is not null then to_timestamp(order_details->>'created_at', 'Dy Mon DD YYYY HH24:MI:SS "GMT+0000 (Coordinated Universal Time)"')
    end,
    case when order_details->>'updated_at' ~ '^\d{4}-' then (order_details->>'updated_at')::timestamptz
         when order_details->>'updated_at' is not null then to_timestamp(order_details->>'updated_at', 'Dy Mon DD YYYY HH24:MI:SS "GMT+0000 (Coordinated Universal Time)"')
    end,
    now()
  from public.alerts
  where
    order_details is not null
    and order_details->>'bosta_id' is not null
  order by (order_details->>'bosta_id'), created_at desc
  on conflict (bosta_id) do update set
    state_code            = excluded.state_code,
    state_value           = excluded.state_value,
    type_code             = excluded.type_code,
    type_value            = excluded.type_value,
    cod                   = excluded.cod,
    shipment_fees         = excluded.shipment_fees,
    attempts_count        = excluded.attempts_count,
    last_exception_code   = excluded.last_exception_code,
    last_exception_reason = excluded.last_exception_reason,
    receiver_name         = excluded.receiver_name,
    receiver_phone        = excluded.receiver_phone,
    weight                = excluded.weight,
    package_type          = excluded.package_type,
    items_count           = excluded.items_count,
    scheduled_at          = excluded.scheduled_at,
    collected_at          = excluded.collected_at,
    bosta_created_at      = excluded.bosta_created_at,
    bosta_updated_at      = excluded.bosta_updated_at,
    synced_at             = excluded.synced_at
  returning id, bosta_id
)
update public.alerts a
set order_id = inserted.id
from inserted
join public.alerts a2 on a2.order_details->>'bosta_id' = inserted.bosta_id
where a.id = a2.id
  and a.order_id is null;
