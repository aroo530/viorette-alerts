import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BOSTA_API_KEY = Deno.env.get("BOSTA_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// State 45 (Delivered) intentionally excluded — we don't alert on delivery
const ALERT_STATE_CODES = new Set([46, 47, 48, 49, 100, 101, 102, 103, 105]);
const PAGE_SIZE = 50;
const RATE_LIMIT_MS = 150;

const now = new Date();
const twoWeeksAgo = new Date(Date.now() - 14 * 86400000)
  .toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
const today = now.toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchPage(page: number): Promise<{ deliveries: unknown[]; total: number }> {
  const res = await fetch("https://app.bosta.co/api/v2/deliveries/search", {
    method: "POST",
    headers: {
      Authorization: BOSTA_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      limit: PAGE_SIZE,
      page,
      sortBy: "-createdAt",
      confirmedAtStart: twoWeeksAgo,
      confirmedAtEnd: today,
    }),
  });
  if (!res.ok) throw new Error(`Bosta HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const payload = data.data && !Array.isArray(data.data) ? data.data : data;
  const total = payload.count ?? payload.total ?? data.count ?? data.total ?? 0;
  const deliveries = payload.deliveries ?? data.list ?? data.deliveries ?? [];
  return { deliveries, total };
}

async function fetchAllOrders() {
  const all: unknown[] = [];
  let page = 1;
  let total = 0;

  do {
    await sleep(RATE_LIMIT_MS);
    const result = await fetchPage(page);
    total = result.total;
    all.push(...result.deliveries);
    console.error(`[Bosta] Fetched ${all.length}/${total}...`);
    if (result.deliveries.length < PAGE_SIZE) break;
    page++;
  } while (all.length < total && page <= 30);

  return all;
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

console.error(`[Config] Checking orders from ${twoWeeksAgo} → ${today}`);
console.error(`[Config] Alert state codes: ${[...ALERT_STATE_CODES].join(", ")}`);

const allOrders = await fetchAllOrders();
const orders = (allOrders as Array<Record<string, unknown>>).filter((d) =>
  ALERT_STATE_CODES.has(((d.state as Record<string, unknown>)?.code as number))
);
console.error(`[Bosta] ${allOrders.length} total orders, ${orders.length} in alertable states`);

let matched = 0;
let missed = 0;

const missedOrders: { tn: string; state: string; ref: string }[] = [];

for (const d of orders) {
  const tn = String((d.trackingNumber as string | number) ?? "");
  const stateCode = (d.state as Record<string, unknown>)?.code;
  const stateVal = String(
    (d.state as Record<string, unknown>)?.value ?? stateCode ?? "?",
  );
  const ref = String(d.businessReference ?? "");

  const { data: realAlert } = await supabase
    .from("alerts")
    .select("id")
    .neq("event_type", "webhook_missed")
    .neq("status", "stored")
    .or(
      `raw_payload->>trackingNumber.eq.${tn},raw_payload->>trackingNumber.eq.${Number(tn)}`,
    )
    .limit(1)
    .maybeSingle();

  if (realAlert) {
    matched++;
    continue;
  }

  missed++;
  missedOrders.push({ tn, state: stateVal, ref });
}

console.log("\n=== Webhook Miss Report ===");
console.log(`Period:   ${twoWeeksAgo} → ${today}`);
console.log(`Checked:  ${orders.length}`);
console.log(`Matched:  ${matched}  (webhook fired correctly)`);
console.log(`Missed:   ${missed}  (no alert found)`);
console.log(
  `Miss rate: ${orders.length > 0 ? ((missed / orders.length) * 100).toFixed(1) : 0}%`,
);

if (missedOrders.length > 0) {
  console.log("\nMissed orders:");
  for (const o of missedOrders) {
    console.log(
      `  #${o.tn.padEnd(12)} state=${o.state}${o.ref ? `  ref=${o.ref}` : ""}`,
    );
  }
}
