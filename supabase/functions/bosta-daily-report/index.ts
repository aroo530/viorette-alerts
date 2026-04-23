const BOSTA_API_KEY = Deno.env.get("BOSTA_API_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;

// Rate limiting: milliseconds between Bosta API calls
const BOSTA_RATE_LIMIT_MS = 100;
// Bosta API hard-caps pages at 50 deliveries
const BOSTA_PAGE_SIZE = 50;

// Telegram message limit (safe margin below 4096)
const TELEGRAM_MSG_LIMIT = 4000;

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
  receiver?: { fullName?: string; firstName?: string; lastName?: string; phone?: string };
  dropOffAddress?: { firstLine?: string; city?: { name?: string } };
  businessReference?: string;
  cod?: number;
  deliveryAttemptsLength?: number;
  specs?: { packageType?: string; packageDetails?: { itemsCount?: number } };
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
  success?: boolean;
  message?: string;
  data?: { deliveries?: BostaDelivery[]; count?: number; total?: number };
  list?: BostaDelivery[];
  deliveries?: BostaDelivery[];
  pageLimit?: number;
  total?: number;
  count?: number;
}

// State code groups
const ACTIVE_STATES = new Set([
  10, 11, 20, 21, 22, 23, 24, 25, 30, 40, 41, 105,
]);
const EXCEPTION_STATES = new Set([47]);
const DELIVERED_STATES = new Set([45]);
const RETURNED_STATES = new Set([46, 60]);
const PROBLEMATIC_STATES = new Set([48, 100, 101, 102, 103]);

function cairoDateString(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}

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
  if (!raw) return ""
  const ts = typeof raw === "number" ? raw : Date.parse(raw)
  if (isNaN(ts)) return ""
  return new Date(ts).toLocaleDateString("en-GB", {
    day: "2-digit", month: "short", timeZone: "Africa/Cairo",
  })
}

function formatOrderBlock(tn: string, d: BostaDelivery): string {
  const url      = getOrderUrl(tn)
  const name     = deliveryName(d)
  const stateVal = d.state?.value ?? `Code ${d.state?.code ?? "?"}`
  const attempts = d.deliveryAttemptsLength ?? 0
  const city     = d.dropOffAddress?.city?.name ?? ""
  const isRTO    = d.changedToRTODate != null || d.type?.code === 20
  const typeTag  = isRTO ? "↩️ Return to Origin" : "📦 Forward"
  const ref      = d.businessReference ?? ""

  // Last exception: prefer state.exception array, fall back to attempts
  const lastExc =
    (d.state?.exception?.length ?? 0) > 0
      ? d.state!.exception![d.state!.exception!.length - 1]
      : d.attempts?.length
        ? d.attempts[d.attempts.length - 1].exception
        : undefined

  // Next scheduled date
  const scheduledStr = formatScheduledAt(d.scheduledAt)

  const lines: string[] = []
  lines.push(`<b><a href="${url}">#${tn}</a></b> — ${name}`)
  if (city)   lines.push(`📍 ${city}`)
  lines.push(`${typeTag}  ·  <i>${stateVal}</i>${attempts > 0 ? `  ·  ${attempts} attempt(s)` : ""}`)
  if (lastExc?.reason)                  lines.push(`⚠️ ${lastExc.reason}`)
  if (d.state?.waitingForBusinessAction) lines.push(`🔔 Waiting for your action`)
  if (scheduledStr)                      lines.push(`📅 Next: ${scheduledStr}`)
  if (!isRTO && d.cod)                   lines.push(`💰 COD: ${d.cod} EGP`)
  if (ref)                               lines.push(`🔖 ${ref}`)

  return lines.join("\n")
}

async function searchBosta(
  params: Record<string, unknown>,
  page = 1,
): Promise<{ deliveries: BostaDelivery[]; total: number }> {
  try {
    const reqBody = { limit: BOSTA_PAGE_SIZE, page, sortBy: "-updatedAt", ...params };
    const res = await fetch("https://app.bosta.co/api/v2/deliveries/search", {
      method: "POST",
      headers: {
        Authorization: `${BOSTA_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reqBody),
    });

    if (!res.ok) {
      console.error(`[Bosta] HTTP ${res.status} ${res.statusText}`);
      return { deliveries: [], total: 0 };
    }

    const data = (await res.json()) as BostaSearchResponse;
    const payload = data.data && !Array.isArray(data.data) ? data.data : data;
    const total = payload.count ?? payload.total ?? data.count ?? data.total ?? 0;

    const deliveries = payload.deliveries ?? data.list ?? data.deliveries;
    if (!Array.isArray(deliveries)) {
      console.error("[Bosta] Invalid response format: no delivery array found", { data });
      return { deliveries: [], total };
    }

    console.log(`[Bosta] Page ${page}: fetched ${deliveries.length} deliveries`);
    return { deliveries, total };
  } catch (err) {
    console.error(`[Bosta] Request failed:`, err);
    return { deliveries: [], total: 0 };
  }
}

async function searchBostaAllPages(params: Record<string, unknown>): Promise<BostaDelivery[]> {
  const allDeliveries: BostaDelivery[] = [];
  let page = 1;
  const maxPages = 30;

  while (page <= maxPages) {
    await new Promise((resolve) => setTimeout(resolve, BOSTA_RATE_LIMIT_MS));
    const { deliveries, total } = await searchBosta(params, page);

    if (deliveries.length === 0) break;
    allDeliveries.push(...deliveries);
    console.log(`[Bosta] Progress: ${allDeliveries.length}/${total || "?"}`);

    if (deliveries.length < BOSTA_PAGE_SIZE) break;

    page++;
  }

  console.log(
    `[Bosta] Total deliveries across ${page} page(s): ${allDeliveries.length}`,
  );
  return allDeliveries;
}

function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MSG_LIMIT) return [text]
  const chunks: string[] = []
  const lines = text.split("\n")
  let current = ""
  for (const line of lines) {
    if (current.length + line.length + 1 > TELEGRAM_MSG_LIMIT) {
      if (current) chunks.push(current)
      current = line
    } else {
      current = current ? `${current}\n${line}` : line
    }
  }
  if (current) chunks.push(current)
  return chunks
}

async function sendTelegramMessage(text: string): Promise<boolean> {
  const chunks = splitMessage(text);

  for (const chunk of chunks) {
    try {
      const tgRes = await fetch(
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

      if (!tgRes.ok) {
        const err = await tgRes.text();
        console.error(`[Telegram] HTTP ${tgRes.status}: ${err}`);
        return false;
      }

      console.log(`[Telegram] Message sent (${chunk.length} chars)`);
    } catch (err) {
      console.error(`[Telegram] Request failed:`, err);
      return false;
    }
  }

  return true;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const check = Number(body.check ?? 4);

    console.log(`[Start] Check ${check}`);

    const allOrders = await searchBostaAllPages({
      dateRangeStart:  cairoDateString(-7),
      dateRangeEnd:    cairoDateString(0),
      dateRangeStates: "10,21,25,45F,45CC,46C,46E,46S,46PC,46R,60,100,101",
    });

    if (allOrders.length === 0) {
      console.warn("[Warning] No orders found. API may be unreachable.");
    }

    const dateRange = getDateRangeFromOrders(allOrders);
    console.log(
      `[Orders] Date range: ${dateRange.oldest} to ${dateRange.newest}`,
    );

    const active: DeliveryEntry[] = [];
    const exceptions: DeliveryEntry[] = [];
    const delivered: DeliveryEntry[] = [];
    const returned: DeliveryEntry[] = [];
    const problematic: DeliveryEntry[] = [];

    for (const d of allOrders) {
      const code = d.state?.code ?? -1;
      const tn = String(d.trackingNumber);
      const entry = { tn, d };
      if (ACTIVE_STATES.has(code)) active.push(entry);
      else if (EXCEPTION_STATES.has(code)) exceptions.push(entry);
      else if (DELIVERED_STATES.has(code)) delivered.push(entry);
      else if (RETURNED_STATES.has(code)) returned.push(entry);
      else if (PROBLEMATIC_STATES.has(code)) problematic.push(entry);
    }

    const outstanding = [...active, ...exceptions, ...problematic];
    const multiAttempt = outstanding.filter(
      ({ d }) => (d.deliveryAttemptsLength ?? 0) >= 2,
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
          lines.push(""); lines.push(formatOrderBlock(tn, d));
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
      const totalResolved =
        delivered.length + returned.length + problematic.length;
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
          lines.push(""); lines.push(formatOrderBlock(tn, d));
        }
      }
    }

    const message = lines.join("\n");
    console.log(`[Message] Generated ${message.length} chars`);

    const success = await sendTelegramMessage(message);

    if (!success) {
      return new Response(JSON.stringify({ error: "Telegram send failed" }), {
        status: 500,
      });
    }

    console.log(`[Success] Check ${check} completed`);
    return new Response(
      JSON.stringify({
        ok: true,
        check,
        totalOrders: allOrders.length,
        outstanding: outstanding.length,
        dateRange,
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("[Fatal]", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
    });
  }
});
