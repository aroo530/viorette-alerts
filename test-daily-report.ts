// Run: deno run --allow-net --allow-env --env-file .env.local test-daily-report.ts [check]
// check: 1=morning 2=midday 3=afternoon 4=eod (default: 4)

const BOSTA_API_KEY = Deno.env.get("BOSTA_API_KEY")!;
const BOSTA_RATE_LIMIT_MS = 100;
const TELEGRAM_MSG_LIMIT = 4000;

const check = Number(Deno.args[0] ?? 4);

// ── Env sanity check ─────────────────────────────────────────────────────────
console.log("═══════════════════════════════════════════");
console.log(`[Config] check=${check}`);
console.log(
  `[Config] BOSTA_API_KEY     : ${BOSTA_API_KEY ? `set (${BOSTA_API_KEY.slice(0, 8)}...)` : "MISSING ⚠️"}`,
);
if (!BOSTA_API_KEY) {
  console.error(
    "[Fatal] Missing required env vars. Fill in .env.local and retry.",
  );
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
    lastExceptionCode?: number;
    waitingForBusinessAction?: boolean;
    canceled?: { time?: string };
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
  attempts?: Array<{
    exception?: BostaException;
    attemptDate?: string;
    star?: { name?: string };
    state?: number;
  }>;
  scheduledAt?: string | number;
  changedToRTODate?: string;
  updatedAt?: string;
  createdAt?: string;
}

interface DeliveryEntry {
  tn: string;
  d: BostaDelivery;
}

interface BostaSearchResponse {
  // v2 envelope: { success, message, data: { deliveries, count } }
  success?: boolean;
  message?: string;
  data?: {
    deliveries?: BostaDelivery[];
    count?: number;
    total?: number;
  };
  // v0 flat fields (fallback)
  list?: BostaDelivery[];
  deliveries?: BostaDelivery[];
  pageLimit?: number;
  total?: number;
  count?: number;
}

// ── State groups ──────────────────────────────────────────────────────────────
const ACTIVE_STATES = new Set([
  10, 11, 20, 21, 22, 23, 24, 25, 30, 40, 41, 105,
]);
const EXCEPTION_STATES = new Set([47]);
const DELIVERED_STATES = new Set([45]);
const RETURNED_STATES = new Set([46, 60]);
const PROBLEMATIC_STATES = new Set([48, 100, 101, 102, 103]);

// ── Helpers ───────────────────────────────────────────────────────────────────
function getDateRangeFromOrders(orders: BostaDelivery[]): {
  oldest: string;
  newest: string;
} {
  let oldest = cairoDateString(0);
  let newest = cairoDateString(0);
  for (const d of orders) {
    if (d.createdAt) {
      const date = d.createdAt.split("T")[0];
      if (date < oldest) oldest = date;
      if (date > newest) newest = date;
    }
  }
  return { oldest, newest };
}

function deliveryName(d: BostaDelivery): string {
  const r = d.receiver;
  if (!r) return "Unknown";
  const fullName =
    r.fullName || [r.firstName, r.lastName].filter(Boolean).join(" ");
  if (fullName) return fullName;
  if (r.phone) return `+${r.phone}`;
  return "Unknown";
}

function getOrderUrl(tn: string | number): string {
  return `https://business.bosta.co/orders/${tn}`;
}

function formatScheduledAt(raw?: string | number): string {
  if (!raw) return "";
  const ts = typeof raw === "number" ? raw : Date.parse(raw);
  if (isNaN(ts)) return "";
  return new Date(ts).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
  });
}

function formatOrderBlock(tn: string, d: BostaDelivery): string {
  const url = getOrderUrl(tn);
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

  const scheduledStr = formatScheduledAt(d.scheduledAt);

  const lines: string[] = [];
  lines.push(`<b><a href="${url}">#${tn}</a></b> — ${name}`);
  if (city) lines.push(`📍 ${city}`);
  lines.push(
    `${typeTag}  ·  <i>${stateVal}</i>${attempts > 0 ? `  ·  ${attempts} attempt(s)` : ""}`,
  );
  if (lastExc?.reason) lines.push(`⚠️ ${lastExc.reason}`);
  if (d.state?.waitingForBusinessAction)
    lines.push(`🔔 Waiting for your action`);
  if (scheduledStr) lines.push(`📅 Next: ${scheduledStr}`);
  if (!isRTO && d.cod) lines.push(`💰 COD: ${d.cod} EGP`);
  if (ref) lines.push(`🔖 ${ref}`);
  return lines.join("\n");
}

// ── Bosta API (v2) ────────────────────────────────────────────────────────────
const BOSTA_PAGE_SIZE = 50;

function cairoDateString(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleString("en-CA", { timeZone: "Africa/Cairo" }).split(" ")[0];
}

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
    `[Bosta] POST /api/v2/deliveries/search page=${page} params=${JSON.stringify(params)}`,
  );
  const t0 = Date.now();

  try {
    const res = await fetch("https://app.bosta.co/api/v2/deliveries/search", {
      method: "POST",
      headers: {
        Authorization: `${BOSTA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reqBody),
    });

    const elapsed = Date.now() - t0;
    console.log(`[Bosta] HTTP ${res.status} ${res.statusText} (${elapsed}ms)`);
    if (!res.ok) {
      const body = await res.text();
      console.error(`[Bosta] Error body: ${body}`);
      return { deliveries: [], total: 0 };
    }
    const data = (await res.json()) as BostaSearchResponse;
    // v2 nests everything under data.data; v0 is flat
    const payload = data.data && !Array.isArray(data.data) ? data.data : data;
    const total =
      payload.count ?? payload.total ?? data.count ?? data.total ?? 0;
    console.log(
      `[Bosta] Response keys: ${Object.keys(data).join(", ")} | total=${total}`,
    );

    const deliveries = payload.deliveries ?? data.list ?? data.deliveries;
    if (!Array.isArray(deliveries)) {
      console.error(
        "[Bosta] No delivery array in response:",
        JSON.stringify(data).slice(0, 300),
      );
      return { deliveries: [], total };
    }

    console.log(`[Bosta] Page ${page}: ${deliveries.length} deliveries`);
    return { deliveries, total };
  } catch (err) {
    console.error(`[Bosta] Request threw:`, err);
    return { deliveries: [], total: 0 };
  }
}

async function searchBostaAllPages(
  params: Record<string, unknown>,
): Promise<BostaDelivery[]> {
  const all: BostaDelivery[] = [];
  let page = 1;
  const maxPages = 30;

  while (page <= maxPages) {
    await new Promise((r) => setTimeout(r, BOSTA_RATE_LIMIT_MS));
    const { deliveries, total } = await searchBosta(params, page);

    if (deliveries.length === 0) {
      console.log(`[Bosta] Empty page ${page}, stopping.`);
      break;
    }

    all.push(...deliveries);
    console.log(`[Bosta] Progress: ${all.length}/${total || "?"}`);

    if (deliveries.length < BOSTA_PAGE_SIZE) {
      console.log(
        `[Bosta] Partial page (${deliveries.length}<${BOSTA_PAGE_SIZE}), last page.`,
      );
      break;
    }
    page++;
  }

  console.log(`[Bosta] Total fetched: ${all.length} across ${page} page(s)`);
  return all;
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

async function sendTelegramMessage(text: string): Promise<boolean> {
  const chunks = splitMessage(text);
  console.log(
    `[Telegram] Sending ${chunks.length} chunk(s), total ${text.length} chars`,
  );

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(
      `[Telegram] Chunk ${i + 1}/${chunks.length}: ${chunk.length} chars`,
    );

    try {
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

      if (!res.ok) {
        const err = await res.text();
        console.error(`[Telegram] HTTP ${res.status}: ${err}`);
        return false;
      }

      const tgBody = await res.json();
      console.log(`[Telegram] OK — message_id=${tgBody?.result?.message_id}`);
    } catch (err) {
      console.error(`[Telegram] Threw:`, err);
      return false;
    }
  }

  return true;
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log(`[Start] Check ${check} · ${new Date().toISOString()}`);

const allOrders = await searchBostaAllPages({
  dateRangeStart: cairoDateString(0),
  dateRangeEnd: cairoDateString(1),
  dateRangeStates: "10,21,25,45F,45CC,46C,46E,46S,46PC,46R,60,100,101",
});
console.log(
  `[Filter] date range: ${cairoDateString(0)} → ${cairoDateString(1)}`,
);

if (allOrders.length === 0) {
  console.warn(
    "[Warning] No orders returned — API may be unreachable or key is wrong.",
  );
}

// Sample first order to verify field shape
if (allOrders.length > 0) {
  const sample = allOrders[0];
  console.log(
    "[Debug] First order sample:",
    JSON.stringify(
      {
        _id: sample._id,
        trackingNumber: sample.trackingNumber,
        stateCode: sample.state?.code,
        stateValue: sample.state?.value,
        typeCode: sample.type?.code,
        exceptionCount: sample.state?.exception?.length ?? 0,
        attemptsLength: sample.deliveryAttemptsLength,
        scheduledAt: sample.scheduledAt,
        changedToRTODate: sample.changedToRTODate,
        createdAt: sample.createdAt,
      },
      null,
      2,
    ),
  );
}

const dateRange = getDateRangeFromOrders(allOrders);
console.log(`[Orders] Date range: ${dateRange.oldest} → ${dateRange.newest}`);

const active: DeliveryEntry[] = [];
const exceptions: DeliveryEntry[] = [];
const delivered: DeliveryEntry[] = [];
const returned: DeliveryEntry[] = [];
const problematic: DeliveryEntry[] = [];
const uncategorized: DeliveryEntry[] = [];

for (const d of allOrders) {
  const code = d.state?.code ?? -1;
  const tn = String(d.trackingNumber);
  const entry = { tn, d };
  if (ACTIVE_STATES.has(code)) active.push(entry);
  else if (EXCEPTION_STATES.has(code)) exceptions.push(entry);
  else if (DELIVERED_STATES.has(code)) delivered.push(entry);
  else if (RETURNED_STATES.has(code)) returned.push(entry);
  else if (PROBLEMATIC_STATES.has(code)) problematic.push(entry);
  else {
    uncategorized.push(entry);
    console.log(`[Categorize] Unknown state code ${code} for TN ${tn}`);
  }
}

const outstanding = [...active, ...exceptions, ...problematic];
const multiAttempt = outstanding.filter(
  ({ d }) => (d.deliveryAttemptsLength ?? 0) >= 2,
);

console.log(
  `[Categorize] active=${active.length} exceptions=${exceptions.length} delivered=${delivered.length} returned=${returned.length} problematic=${problematic.length} uncategorized=${uncategorized.length}`,
);
console.log(
  `[Categorize] outstanding=${outstanding.length} multiAttempt=${multiAttempt.length}`,
);

const timeStr = new Date().toLocaleString("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Africa/Cairo",
});

const CHECK_HEADER: Record<number, string> = {
  1: `🌅 Morning Check · ${timeStr}`,
  2: `☀️ Midday Check · ${timeStr}`,
  3: `🌤️ Afternoon Spot-Check · ${timeStr}`,
  4: `🌙 End of Day · ${timeStr}`,
};

const lines: string[] = [
  `<b>${CHECK_HEADER[check] ?? `📊 Check ${check} · ${timeStr}`}</b>`,
  `<i>Data range: ${dateRange.oldest} to ${dateRange.newest}</i>`,
  "",
];

if (check === 1) {
  lines.push(`📦 Total orders: <b>${allOrders.length}</b>`);
  lines.push(`✅ Delivered: <b>${delivered.length}</b>`);
  lines.push(`🚚 Active: <b>${active.length}</b>`);
  lines.push(`⚡ Exceptions: <b>${exceptions.length}</b>`);
  lines.push(`❌ Problematic: <b>${problematic.length}</b>`);

  if (outstanding.length > 0) {
    lines.push("");
    lines.push(`<b>⏳ Outstanding orders (${outstanding.length}):</b>`);
    for (const { tn, d } of outstanding) {
      lines.push("");
      lines.push(formatOrderBlock(tn, d));
    }
  }
} else if (check === 2) {
  lines.push(`📦 Active orders: <b>${active.length}</b>`);
  lines.push(`✅ Delivered: <b>${delivered.length}</b>`);
  lines.push(`⚡ Exceptions: <b>${exceptions.length}</b>`);
  lines.push(`❌ Problematic: <b>${problematic.length}</b>`);
  if (multiAttempt.length > 0) {
    lines.push(`⚠️ Multi-attempt: <b>${multiAttempt.length}</b>`);
  }
} else if (check === 3) {
  lines.push(`✅ Delivered: <b>${delivered.length}</b>`);
  lines.push(`📦 Still outstanding: <b>${outstanding.length}</b>`);
  lines.push(`⚡ Exceptions: <b>${exceptions.length}</b>`);
  if (multiAttempt.length > 0) {
    lines.push(`⚠️ Multi-attempt: <b>${multiAttempt.length}</b>`);
  }
} else {
  const totalResolved = delivered.length + returned.length + problematic.length;
  const successRate =
    totalResolved > 0
      ? Math.round((delivered.length / totalResolved) * 100)
      : null;

  lines.push("<b>📊 Daily Summary</b>");
  lines.push(`✅ Delivered: <b>${delivered.length}</b>`);
  lines.push(`🔄 Returned: <b>${returned.length}</b>`);
  lines.push(`⚡ Exceptions: <b>${exceptions.length}</b>`);
  lines.push(`❌ Terminated / Lost: <b>${problematic.length}</b>`);
  lines.push(`📦 Still outstanding: <b>${active.length}</b>`);

  if (successRate !== null) {
    lines.push("");
    lines.push(
      `📈 Success rate: <b>${successRate}%</b> (${delivered.length} of ${totalResolved} resolved)`,
    );
  }

  if (outstanding.length > 0) {
    lines.push("");
    lines.push(`<b>⏳ Outstanding orders (${outstanding.length}):</b>`);
    for (const { tn, d } of outstanding) {
      lines.push("");
      lines.push(formatOrderBlock(tn, d));
    }
  }
}

const message = lines.join("\n");
console.log(`[Message] ${message.length} chars, ${lines.length} lines`);
console.log("─── Preview (first 800 chars) ───");
console.log(message.slice(0, 800));
console.log("─────────────────────────────────");

// const success = await sendTelegramMessage(message);
// if (success) {
//   console.log("[Done] Message sent successfully ✓");
// } else {
//   console.error("[Done] Failed to send message ✗");
//   Deno.exit(1);
// }
