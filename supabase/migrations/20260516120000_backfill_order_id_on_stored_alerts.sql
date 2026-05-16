update public.alerts a
set order_id = bo.id
from public.bosta_orders bo
where a.order_id is null
  and bo.tracking_number = a.raw_payload->>'trackingNumber';
