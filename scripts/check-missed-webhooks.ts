import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOSTA_API_KEY = Deno.env.get("BOSTA_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BOSTA_PAGE_SIZE = 50;
const BOSTA_RATE_LIMIT_MS = 150;
const ALERT_STATES = [46, 47, 48, 49, 100, 101, 102, 103, 105];

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function cairoDateString(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}

function toISO(val: string | null | undefined): string | null {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

interface BostaDelivery {
  _id: string;
  trackingNumber: string | number;
  businessReference?: string;
  state?: { code?: number; value?: string };
  type?: { code?: number; value?: string };
  receiver?: { fullName?: string; firstName?: string; lastName?: string; phone?: string };
  cod?: number;
  shipmentFees?: number;
  attemptsCount?: number;
  specs?: { weight?: number; packageType?: string; packageDetails?: { itemsCount?: number } };
  scheduledAt?: string;
  collectedFromConsignee?: string;
  createdAt?: string;
  updatedAt?: string;
  exceptionLog?: { reason?: string; code?: number }[];
  exception?: { reason?: string; code?: number };
}

async function fetchAllOrders(): Promise<BostaDelivery[]> {
  const all: BostaDelivery[] = [];
  let page = 1;

  while (page <= 30) {
    await sleep(BOSTA_RATE_LIMIT_MS);
    const res = await fetch("https://app.bosta.co/api/v2/deliveries/search", {
      method: "POST",
      headers: { Authorization: BOSTA_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        limit: BOSTA_PAGE_SIZE,
        page,
        sortBy: "-updatedAt",
        confirmedAtStart: cairoDateString(-14),
        confirmedAtEnd: cairoDateString(0),
      }),
    });

    if (!res.ok) {
      console.error(`[Bosta] HTTP ${res.status}`);
      break;
    }

    const data = await res.json();
    const payload = data.data && !Array.isArray(data.data) ? data.data : data;
    const total = payload.count ?? payload.total ?? data.count ?? data.total ?? 0;
    const deliveries: BostaDelivery[] = payload.deliveries ?? data.list ?? data.deliveries ?? [];

    all.push(...deliveries);
    console.error(`[Bosta] Page ${page}: ${deliveries.length} fetched (${all.length}/${total} total)`);
    if (deliveries.length < BOSTA_PAGE_SIZE) break;
    page++;
  }

  return all;
}

function buildOrderRow(d: BostaDelivery) {
  const log = d.exceptionLog;
  const lastException = (log && log.length > 0 ? log[log.length - 1] : null) ?? d.exception ?? null;
  return {
    bosta_id:              d._id,
    tracking_number:       String(d.trackingNumber),
    business_reference:    d.businessReference ?? null,
    type_code:             d.type?.code ?? null,
    type_value:            d.type?.value ?? null,
    cod:                   d.cod ?? null,
    shipment_fees:         d.shipmentFees ?? null,
    attempts_count:        d.attemptsCount ?? null,
    last_exception_code:   lastException?.code ?? null,
    last_exception_reason: lastException?.reason ?? null,
    receiver_name:         (d.receiver?.fullName || [d.receiver?.firstName, d.receiver?.lastName].filter(Boolean).join(" ")) || null,
    receiver_phone:        d.receiver?.phone ?? null,
    weight:                d.specs?.weight ?? null,
    package_type:          d.specs?.packageType ?? null,
    items_count:           d.specs?.packageDetails?.itemsCount ?? null,
    scheduled_at:          toISO(d.scheduledAt),
    collected_at:          toISO(d.collectedFromConsignee),
    bosta_created_at:      toISO(d.createdAt),
    bosta_updated_at:      toISO(d.updatedAt),
    synced_at:             new Date().toISOString(),
  };
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

console.error(`[Config] Range: ${cairoDateString(-14)} → ${cairoDateString(0)}`);
console.error(`[Config] Alertable states: ${ALERT_STATES.join(", ")}`);

const allOrders = await fetchAllOrders();
console.error(`[webhook-miss] ${allOrders.length} total orders fetched`);

let synced = 0;
let missed = 0;
let alerted = 0;

for (const d of allOrders) {
  const tn = String(d.trackingNumber);
  const stateCode = d.state?.code;

  const { data: orderRow, error: upsertErr } = await supabase
    .from("bosta_orders")
    .upsert(buildOrderRow(d), { onConflict: "bosta_id", ignoreDuplicates: false })
    .select("id")
    .single();

  if (upsertErr || !orderRow) {
    console.error(`[webhook-miss] Failed to upsert order ${tn}:`, upsertErr?.message);
    continue;
  }

  synced++;
  const orderId = orderRow.id;

  if (stateCode == null || !ALERT_STATES.includes(stateCode)) continue;

  const { data: realAlert } = await supabase
    .from("alerts")
    .select("id")
    .eq("order_id", orderId)
    .eq("metric_value", stateCode)
    .neq("event_type", "webhook_missed")
    .neq("status", "stored")
    .limit(1)
    .maybeSingle();

  if (realAlert) continue;

  missed++;

  const { data: recentMiss } = await supabase
    .from("alerts")
    .select("id")
    .eq("order_id", orderId)
    .eq("event_type", "webhook_missed")
    .eq("metric_value", stateCode)
    .gte("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString())
    .limit(1)
    .maybeSingle();

  if (recentMiss) {
    console.error(`[webhook-miss] Already alerted for ${tn} state ${stateCode} within 24h — skipping`);
    continue;
  }

  const stateVal = d.state?.value ?? `State ${stateCode}`;
  const message = `🔴 CRITICAL | Webhook missed for #${tn} — order is in state "${stateVal}" but no alert was received.`;

  const { error: insertErr } = await supabase.from("alerts").insert({
    source: "bosta",
    event_type: "webhook_missed",
    metric_name: "shipment_state",
    metric_value: stateCode,
    message,
    status: "pending",
    order_id: orderId,
    raw_payload: { _id: d._id, trackingNumber: d.trackingNumber, state: stateCode, type: d.type?.value },
  });

  if (insertErr) {
    console.error(`[webhook-miss] Failed to insert alert for ${tn}:`, insertErr.message);
  } else {
    alerted++;
    console.log(`[webhook-miss] Created webhook_missed alert for #${tn} (state ${stateCode}: ${stateVal})`);
  }
}

console.log(`\n=== Webhook Miss Report ===`);
console.log(`Synced:  ${synced}  (orders upserted to bosta_orders)`);
console.log(`Missed:  ${missed}  (in alertable state, no real alert found)`);
console.log(`Alerted: ${alerted}  (new webhook_missed alerts created)`);
