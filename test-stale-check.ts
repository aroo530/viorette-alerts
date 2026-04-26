// Run: deno run --allow-net --allow-env --env-file=.env.local test-stale-check.ts

const BOSTA_API_KEY = Deno.env.get("BOSTA_API_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;

const BOSTA_PAGE_SIZE = 50;
const BOSTA_RATE_LIMIT_MS = 150;
const TELEGRAM_MSG_LIMIT = 4000;

// new=10, picked_up=21, in_progress=24/25/30, heading_to_customer=41
const ACTIVE_STATES = new Set([10, 21, 24, 25, 30, 41]);

// ── Env check ────────────────────────────────────────────────────────────────
console.log("═══════════════════════════════════════════════════════════");
console.log("[Config] bosta-stale-check test");
console.log(
  `[Config] BOSTA_API_KEY      : ${BOSTA_API_KEY ? `set (${BOSTA_API_KEY.slice(0, 8)}...)` : "MISSING ⚠️"}`,
);

if (!BOSTA_API_KEY) {
  console.error("[Fatal] Missing env vars. Fill in .env.local and retry.");
  Deno.exit(1);
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface BostaException {
  reason?: string;
  code?: number;
  time?: string;
}

interface BostaDelivery {
  _id: string;
  trackingNumber: string | number;
  state?: {
    code?: number;
    value?: string;
    exception?: BostaException[];
    waitingForBusinessAction?: boolean;
  };
  type?: { code?: number; value?: string };
  receiver?: {
    fullName?: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
  };
  dropOffAddress?: { firstLine?: string; city?: { name?: string } };
  businessReference?: string;
  cod?: number;
  deliveryAttemptsLength?: number;
  scheduledAt?: string | number;
  changedToRTODate?: string;
  updatedAt?: string;
  createdAt?: string;
  attempts?: Array<{ exception?: BostaException }>;
}

interface StarAction {
  time?: string;
  createdAt?: string;
  date?: string;
  updatedAt?: string;
  type?: string;
  reason?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function cairoDateString(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}

function deliveryName(d: BostaDelivery): string {
  const r = d.receiver;
  if (!r) return "Unknown";
  const full =
    r.fullName || [r.firstName, r.lastName].filter(Boolean).join(" ");
  if (full) return full;
  if (r.phone) return `+${r.phone}`;
  return "Unknown";
}

// ── Bosta search ──────────────────────────────────────────────────────────────
async function searchBosta(
  params: Record<string, unknown>,
  page = 1,
): Promise<{ deliveries: BostaDelivery[]; total: number }> {
  const reqBody = {
    limit: BOSTA_PAGE_SIZE,
    page,
    sortBy: "-updatedAt",
    ...params,
  };
  console.log(
    `  → POST /deliveries/search page=${page}`,
    JSON.stringify(reqBody),
  );
  const t0 = Date.now();

  const res = await fetch("https://app.bosta.co/api/v2/deliveries/search", {
    method: "POST",
    headers: {
      Authorization: BOSTA_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(reqBody),
  });

  console.log(`  ← HTTP ${res.status} in ${Date.now() - t0}ms`);

  if (!res.ok) {
    console.error(`[Bosta] HTTP ${res.status} ${res.statusText}`);
    return { deliveries: [], total: 0 };
  }

  const data = await res.json();
  console.log(`  ← Response keys: ${Object.keys(data).join(", ")}`);

  const payload = data.data && !Array.isArray(data.data) ? data.data : data;
  const total = payload.count ?? payload.total ?? data.count ?? data.total ?? 0;
  const deliveries = payload.deliveries ?? data.list ?? data.deliveries;

  if (!Array.isArray(deliveries)) {
    console.error(
      "[Bosta] No delivery array",
      JSON.stringify(data).slice(0, 300),
    );
    return { deliveries: [], total };
  }

  console.log(
    `  ← Page ${page}: ${deliveries.length} deliveries (total server-side: ${total})`,
  );
  return { deliveries, total };
}

async function fetchActiveOrders(): Promise<BostaDelivery[]> {
  console.log("\n[Fetch] Fetching orders from last 7 days...");
  const todayStr = cairoDateString(0);
  // const weekAgoStr = cairoDateString(-7);
  const twoWeeksAgoStr = cairoDateString(-14);
  console.log(`[Fetch] Date range: ${twoWeeksAgoStr} → ${todayStr}`);

  const all: BostaDelivery[] = [];
  let page = 1;

  while (page <= 30) {
    await sleep(BOSTA_RATE_LIMIT_MS);
    const { deliveries, total } = await searchBosta(
      {
        dateRangeStart: twoWeeksAgoStr,
        dateRangeEnd: todayStr,
        dateRangeStates: "10,21,25,45F,45CC,46C,46E,46S,46PC,46R,60,100,101",
      },
      page,
    );
    if (deliveries.length === 0) break;
    all.push(...deliveries);
    console.log(`[Fetch] Progress: ${all.length}/${total}`);
    if (deliveries.length < BOSTA_PAGE_SIZE) break;
    page++;
  }

  console.log(`[Fetch] Total fetched: ${all.length}`);

  const active = all.filter((d) => ACTIVE_STATES.has(d.state?.code ?? -1));
  console.log(
    "[Fetch] Active orders: in Cairo Time",
    active.map(
      (d) =>
        `${d.trackingNumber} - ${d.state?.value} - ${new Date(d.createdAt!).toLocaleString("en-GB", { timeZone: "Africa/Cairo" })} - ${new Date(d.updatedAt!).toLocaleString("en-GB", { timeZone: "Africa/Cairo" })} \n`,
    ),
  );
  const stateCounts: Record<number, number> = {};
  for (const d of all) {
    const c = d.state?.code ?? -1;
    stateCounts[c] = (stateCounts[c] ?? 0) + 1;
  }
  console.log("[Fetch] State breakdown:", JSON.stringify(stateCounts));
  console.log(`[Filter] Active/exception orders: ${active.length}`);

  return active;
}

// ── Star actions ──────────────────────────────────────────────────────────────
async function getLastActionDate(
  trackingNumber: string,
): Promise<{ date: string | null; rawCount: number }> {
  await sleep(BOSTA_RATE_LIMIT_MS);
  const t0 = Date.now();

  const res = await fetch(
    "https://app.bosta.co/api/v2/users/stars/star-actions",
    {
      method: "POST",
      headers: {
        Authorization: BOSTA_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trackingNumber }),
    },
  );

  console.log(
    `  ← TN ${trackingNumber}: HTTP ${res.status} in ${Date.now() - t0}ms`,
  );

  if (!res.ok) {
    const errText = await res.text();
    console.error(`  ← Error body: ${errText.slice(0, 200)}`);
    return { date: null, rawCount: 0 };
  }

  const data = await res.json();
  // console.log(data);
  console.log(`  ← Response keys: ${Object.keys(data).join(", ")}`);

  const actions: StarAction[] = Array.isArray(data)
    ? data
    : Array.isArray(data?.data)
      ? data.data
      : Array.isArray(data?.data?.actions)
        ? data.data.actions
        : Array.isArray(data?.actions)
          ? data.actions
          : [];

  console.log(`  ← ${actions.length} actions found`);
  if (actions.length > 0) {
    console.log(
      `  ← First action sample: ${JSON.stringify(actions[0]).slice(0, 1000)}`,
    );
    console.log(
      `  ← Last  action sample: ${JSON.stringify(actions[actions.length - 1]).slice(0, 200)}`,
    );
  }

  if (actions.length === 0) return { date: null, rawCount: 0 };

  const latestTs = actions.reduce((best, a) => {
    const ts = Date.parse(a.time ?? a.createdAt ?? a.date ?? a.updatedAt ?? "");
    return ts > best ? ts : best;
  }, 0);

  if (!latestTs) return { date: null, rawCount: actions.length };

  const dateStr = new Date(latestTs).toLocaleDateString("en-CA", {
    timeZone: "Africa/Cairo",
  });
  return { date: dateStr, rawCount: actions.length };
}

// ── Telegram ──────────────────────────────────────────────────────────────────
function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MSG_LIMIT) return [text];
  const chunks: string[] = [];
  const lines = text.split("\n");
  let current = "";
  for (const line of lines) {
    if (current.length + line.length + 1 > TELEGRAM_MSG_LIMIT) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function sendTelegramMessage(text: string): Promise<void> {
  const chunks = splitMessage(text);
  console.log(
    `\n[Telegram] Sending ${chunks.length} chunk(s), total ${text.length} chars`,
  );
  for (const [i, chunk] of chunks.entries()) {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: chunk,
          parse_mode: "HTML",
        }),
      },
    );
    const body = await res.json();
    if (!res.ok) {
      console.error(
        `[Telegram] Chunk ${i + 1} failed: ${JSON.stringify(body)}`,
      );
    } else {
      console.log(
        `[Telegram] Chunk ${i + 1}/${chunks.length} sent — message_id: ${body?.result?.message_id}`,
      );
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const todayStr = cairoDateString(0);
const timeStr = new Date().toLocaleString("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Africa/Cairo",
});

console.log(`\n[Start] Today (Cairo): ${todayStr}  Time: ${timeStr}`);

const activeOrders = await fetchActiveOrders();

if (activeOrders.length === 0) {
  console.log("[Done] No active orders to check. Exiting.");
  Deno.exit(0);
}

console.log(
  `\n[StarActions] Checking ${activeOrders.length} orders for stale status...`,
);

type StaleEntry = {
  tn: string;
  d: BostaDelivery;
  lastActionDate: string | null;
};
const stale: StaleEntry[] = [];
let skipped = 0;

for (const d of activeOrders) {
  const tn = String(d.trackingNumber);
  const createdTs = d.createdAt ? Date.parse(d.createdAt) : 0;
  const createdDate = createdTs
    ? new Date(createdTs).toLocaleDateString("en-CA", {
        timeZone: "Africa/Cairo",
      })
    : "";

  // Skip orders created today (no actions yet) or 7+ days ago (too old)
  if (createdDate >= todayStr || createdDate <= cairoDateString(-7)) {
    console.log(`[Skip] TN ${tn} created ${createdDate} — skipping`);
    skipped++;
    continue;
  }

  console.log(
    `\n[Check] TN ${tn} | created: ${createdDate} | state: ${d.state?.value ?? d.state?.code}`,
  );

  // If Bosta itself updated the order today (e.g. status change after midnight Cairo), not stale
  const updatedTs = d.updatedAt ? Date.parse(d.updatedAt) : 0;
  const updatedDate = updatedTs
    ? new Date(updatedTs).toLocaleDateString("en-CA", {
        timeZone: "Africa/Cairo",
      })
    : "";
  console.log(`[Check] TN ${tn} → updatedAt (Cairo): ${updatedDate}`);
  if (updatedDate >= todayStr) {
    console.log(`[Skip] TN ${tn} updatedAt is today — not stale`);
    skipped++;
    continue;
  }

  const { date: lastActionDate, rawCount } = await getLastActionDate(tn);
  console.log(
    `[Check] TN ${tn} → last action: ${lastActionDate ?? "none"} (${rawCount} actions total)`,
  );

  const isStale = lastActionDate === null || lastActionDate < todayStr;
  console.log(`[Check] TN ${tn} → stale: ${isStale}`);
  if (isStale) stale.push({ tn, d, lastActionDate });
}

console.log(`\n═══════════════════════════════════════════════════════════`);
console.log(
  `[Summary] Found: ${activeOrders.length}  Evaluated: ${activeOrders.length - skipped}  Skipped (today): ${skipped}  Stale: ${stale.length}`,
);

if (stale.length === 0) {
  console.log("[Done] All orders up to date — sending clean bill to Telegram.");
  const okMsg = `<b>✅ Stale Check · ${timeStr}</b>\n<i>All ${activeOrders.length} active order${activeOrders.length !== 1 ? "s" : ""} are up to date — no issues found.</i>`;
  await sendTelegramMessage(okMsg);
  Deno.exit(0);
}

// Build message
const lines: string[] = [
  `<b>⚠️ Stale Orders · ${timeStr}</b>`,
  `<i>${stale.length} active order${stale.length > 1 ? "s" : ""} with no Bosta update today</i>`,
];

for (const { tn, d, lastActionDate } of stale) {
  const url = `https://business.bosta.co/orders/${tn}`;
  const name = deliveryName(d);
  const stateVal = d.state?.value ?? `Code ${d.state?.code ?? "?"}`;
  const attempts = d.deliveryAttemptsLength ?? 0;
  const city = d.dropOffAddress?.city?.name ?? "";
  const isRTO = d.changedToRTODate != null || d.type?.code === 20;
  const typeTag = isRTO ? "↩️ Return to Origin" : "📦 Forward";
  const ref = d.businessReference ?? "";

  const lastExc =
    (d.state?.exception?.length ?? 0) > 0
      ? d.state!.exception![d.state!.exception!.length - 1]
      : d.attempts?.length
        ? d.attempts[d.attempts.length - 1].exception
        : undefined;

  lines.push("");
  lines.push(`<b><a href="${url}">#${tn}</a></b> — ${name}`);
  if (city) lines.push(`📍 ${city}`);
  lines.push(
    `${typeTag}  ·  <i>${stateVal}</i>${attempts > 0 ? `  ·  ${attempts} attempt(s)` : ""}`,
  );
  if (lastExc?.reason) lines.push(`⚠️ ${lastExc.reason}`);
  if (d.state?.waitingForBusinessAction)
    lines.push(`🔔 Waiting for your action`);
  lines.push(
    `🕒 Last update: ${
      lastActionDate
        ? new Date(lastActionDate).toLocaleDateString("en-GB", {
            day: "2-digit",
            month: "short",
          })
        : "never"
    }`,
  );
  if (ref) lines.push(`🔖 ${ref}`);
}

const message = lines.join("\n");
console.log(`\n[Message] ${message.length} chars`);
console.log("[Message Preview] ─────────────────────────────────────────");
console.log(message.slice(0, 1000));
console.log("────────────────────────────────────────────────────────────");

await sendTelegramMessage(message);
console.log("[Done]");
export {};
