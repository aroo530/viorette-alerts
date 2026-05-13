import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOSTA_API_KEY = Deno.env.get("BOSTA_API_KEY")!;

const BOSTA_PAGE_SIZE = 50;
const BOSTA_RATE_LIMIT_MS = 150;

// Same alertable states as bosta-webhook
const ALERT_STATES = [46, 47, 48, 49, 100, 101, 102, 103, 105];

interface BostaException {
  reason?: string;
  code?: number;
}

interface BostaDelivery {
  _id: string;
  trackingNumber: string | number;
  businessReference?: string;
  state?: { code?: number; value?: string; exception?: BostaException[] };
  type?: { code?: number; value?: string };
  receiver?: { fullName?: string; firstName?: string; lastName?: string; phone?: string };
  dropOffAddress?: { firstLine?: string; city?: { name?: string } };
  cod?: number;
  shipmentFees?: number;
  attemptsCount?: number;
  specs?: { weight?: number; packageType?: string; packageDetails?: { itemsCount?: number } };
  scheduledAt?: string;
  collectedFromConsignee?: string;
  createdAt?: string;
  updatedAt?: string;
  exceptionLog?: BostaException[];
  exception?: BostaException;
}

interface BostaSearchResponse {
  success?: boolean;
  data?: { deliveries?: BostaDelivery[]; count?: number; total?: number };
  list?: BostaDelivery[];
  deliveries?: BostaDelivery[];
  count?: number;
  total?: number;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function cairoDateString(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}

async function searchBosta(
  page = 1,
): Promise<{ deliveries: BostaDelivery[]; total: number }> {
  try {
    const res = await fetch("https://app.bosta.co/api/v2/deliveries/search", {
      method: "POST",
      headers: { Authorization: BOSTA_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        limit: BOSTA_PAGE_SIZE,
        page,
        sortBy: "-updatedAt",
        dateRangeStart: cairoDateString(-14),
        dateRangeEnd: cairoDateString(0),
      }),
    });

    if (!res.ok) {
      console.error(`[Bosta] HTTP ${res.status} ${res.statusText}`);
      return { deliveries: [], total: 0 };
    }

    const data = (await res.json()) as BostaSearchResponse;
    const payload = data.data && !Array.isArray(data.data) ? data.data : data;
    const total = payload.count ?? payload.total ?? data.count ?? data.total ?? 0;
    const deliveries = payload.deliveries ?? data.list ?? data.deliveries ?? [];

    console.log(`[Bosta] Page ${page}: ${deliveries.length} (${total} total)`);
    return { deliveries, total };
  } catch (err) {
    console.error(`[Bosta] Request failed:`, err);
    return { deliveries: [], total: 0 };
  }
}

async function fetchAllOrders(): Promise<BostaDelivery[]> {
  const all: BostaDelivery[] = [];
  let page = 1;

  while (page <= 30) {
    await sleep(BOSTA_RATE_LIMIT_MS);
    const { deliveries, total } = await searchBosta(page);
    if (deliveries.length === 0) break;
    all.push(...deliveries);
    console.log(`[Bosta] Progress: ${all.length}/${total}`);
    if (deliveries.length < BOSTA_PAGE_SIZE) break;
    page++;
  }

  return all;
}

function toISO(val: string | null | undefined): string | null {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
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
    last_exception_code:   (lastException as BostaException | null)?.code ?? null,
    last_exception_reason: (lastException as BostaException | null)?.reason ?? null,
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

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    console.log("[webhook-miss] Starting check");
    const allOrders = await fetchAllOrders();
    console.log(`[webhook-miss] ${allOrders.length} total orders fetched`);

    let synced = 0;
    let missed = 0;
    let alerted = 0;

    for (const d of allOrders) {
      const tn = String(d.trackingNumber);
      const stateCode = d.state?.code;

      // Upsert every order — insert new, update existing
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

      // Only run alert logic for alertable states
      if (!ALERT_STATES.includes(stateCode as number)) continue;

      // Check if a real (non-missed) webhook alert already exists for this order
      const { data: realAlert } = await supabase
        .from("alerts")
        .select("id")
        .eq("order_id", orderId)
        .neq("event_type", "webhook_missed")
        .neq("status", "stored")
        .limit(1)
        .maybeSingle();

      if (realAlert) {
        // Webhook fired correctly — nothing to do
        continue;
      }

      missed++;

      // Check if we already created a webhook_missed alert for this order in the last 24h
      const { data: recentMiss } = await supabase
        .from("alerts")
        .select("id")
        .eq("order_id", orderId)
        .eq("event_type", "webhook_missed")
        .gte("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString())
        .limit(1)
        .maybeSingle();

      if (recentMiss) {
        console.log(`[webhook-miss] Already alerted for ${tn} within 24h — skipping`);
        continue;
      }

      const stateVal = d.state?.value ?? `State ${d.state?.code ?? "?"}`;
      const message = `🔴 CRITICAL | Webhook missed for #${tn} — order is in state "${stateVal}" but no alert was received.`;

      const { error: insertErr } = await supabase.from("alerts").insert({
        source: "bosta",
        event_type: "webhook_missed",
        metric_name: "shipment_state",
        metric_value: d.state?.code ?? null,
        message,
        status: "pending",
        order_id: orderId,
        raw_payload: {
          _id: d._id,
          trackingNumber: d.trackingNumber,
          state: d.state?.code,
          type: d.type?.value,
        },
      });

      if (insertErr) {
        console.error(`[webhook-miss] Failed to insert alert for ${tn}:`, insertErr.message);
      } else {
        alerted++;
        console.log(`[webhook-miss] Created webhook_missed alert for ${tn}`);
      }
    }

    console.log(`[webhook-miss] Done — synced: ${synced}, missed: ${missed}, alerted: ${alerted}`);
    return new Response(
      JSON.stringify({ ok: true, synced, missed, alerted }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[webhook-miss] Fatal:", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
