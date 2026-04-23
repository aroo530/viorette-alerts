const BOSTA_API_KEY = Deno.env.get("BOSTA_API_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;

const BOSTA_PAGE_SIZE = 50;
const BOSTA_RATE_LIMIT_MS = 150;
const TELEGRAM_MSG_LIMIT = 4000;

// Orders are watched once picked up (21+) until they reach state 41 (heading to customer)
// State 10 (Created, not yet picked up) is excluded — clock hasn't started
const WATCH_STATES = new Set([21, 24, 25, 30]);

// Hours since last Bosta update (updatedAt) thresholds
const WARN_HOURS = 24;
const CRIT_HOURS = 48;

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
  receiver?: { fullName?: string; firstName?: string; lastName?: string; phone?: string };
  dropOffAddress?: { firstLine?: string; city?: { name?: string } };
  businessReference?: string;
  cod?: number;
  deliveryAttemptsLength?: number;
  changedToRTODate?: string;
  updatedAt?: string;
  createdAt?: string;
  attempts?: Array<{ exception?: BostaException }>;
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

function hoursSince(raw: string | number | undefined): number {
  if (!raw) return 0;
  const ts = typeof raw === "number" ? raw : Date.parse(raw);
  if (!ts || isNaN(ts)) return 0;
  return (Date.now() - ts) / 3_600_000;
}

function deliveryName(d: BostaDelivery): string {
  const r = d.receiver;
  if (!r) return "Unknown";
  const full = r.fullName || [r.firstName, r.lastName].filter(Boolean).join(" ");
  if (full) return full;
  if (r.phone) return `+${r.phone}`;
  return "Unknown";
}

function getOrderUrl(tn: string | number): string {
  return `https://business.bosta.co/orders/${tn}`;
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
        Authorization: BOSTA_API_KEY,
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
      console.error("[Bosta] No delivery array in response");
      return { deliveries: [], total };
    }

    console.log(`[Bosta] Page ${page}: ${deliveries.length} (${total} total)`);
    return { deliveries, total };
  } catch (err) {
    console.error(`[Bosta] Request failed:`, err);
    return { deliveries: [], total: 0 };
  }
}

async function fetchWatchedOrders(): Promise<BostaDelivery[]> {
  const all: BostaDelivery[] = [];
  let page = 1;

  while (page <= 30) {
    await sleep(BOSTA_RATE_LIMIT_MS);
    const { deliveries, total } = await searchBosta(
      {
        dateRangeStart: cairoDateString(-7),
        dateRangeEnd: cairoDateString(0),
        dateRangeStates: "21,24,25,30",
      },
      page,
    );

    if (deliveries.length === 0) break;
    all.push(...deliveries);
    console.log(`[Bosta] Progress: ${all.length}/${total}`);
    if (deliveries.length < BOSTA_PAGE_SIZE) break;
    page++;
  }

  return all.filter((d) => WATCH_STATES.has(d.state?.code ?? -1));
}

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
  for (const chunk of splitMessage(text)) {
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
      console.log(`[Telegram] Sent ${chunk.length} chars`);
    } catch (err) {
      console.error(`[Telegram] Request failed:`, err);
      return false;
    }
  }
  return true;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  try {
    const timeStr = new Date().toLocaleString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Africa/Cairo",
    });

    console.log("[Start] Order watch check");

    const orders = await fetchWatchedOrders();
    console.log(`[Watch] ${orders.length} orders in watch states`);

    type FlaggedEntry = {
      tn: string;
      d: BostaDelivery;
      hours: number;
      level: "warn" | "crit";
    };

    const flagged: FlaggedEntry[] = [];

    for (const d of orders) {
      const hours = hoursSince(d.updatedAt);
      if (hours >= WARN_HOURS) {
        flagged.push({
          tn: String(d.trackingNumber),
          d,
          hours,
          level: hours >= CRIT_HOURS ? "crit" : "warn",
        });
      }
    }

    // Most overdue first
    flagged.sort((a, b) => b.hours - a.hours);

    const critCount = flagged.filter((f) => f.level === "crit").length;
    console.log(`[Watch] ${flagged.length} flagged (${critCount} critical)`);

    if (flagged.length === 0) {
      const okMsg = `<b>✅ Order Watch · ${timeStr}</b>\n<i>All ${orders.length} active order${orders.length !== 1 ? "s" : ""} are on track — no delays detected.</i>`;
      await sendTelegramMessage(okMsg);
      return new Response(JSON.stringify({ ok: true, flagged: 0, checked: orders.length }), { status: 200 });
    }

    const lines: string[] = [
      `<b>⚠️ Order Watch · ${timeStr}</b>`,
      `<i>${flagged.length} order${flagged.length !== 1 ? "s" : ""} stuck before "Heading to Customer"${critCount > 0 ? ` · ${critCount} critical (48h+)` : ""}</i>`,
    ];

    for (const { tn, d, hours, level } of flagged) {
      const url = getOrderUrl(tn);
      const name = deliveryName(d);
      const stateVal = d.state?.value ?? `Code ${d.state?.code ?? "?"}`;
      const city = d.dropOffAddress?.city?.name ?? "";
      const isRTO = d.changedToRTODate != null || d.type?.code === 20;
      const typeTag = isRTO ? "↩️ RTO" : "📦 Forward";
      const ref = d.businessReference ?? "";
      const hoursLabel = level === "crit"
        ? `🔴 ${Math.round(hours)}h since last update (critical)`
        : `🟡 ${Math.round(hours)}h since last update`;

      const lastExc =
        (d.state?.exception?.length ?? 0) > 0
          ? d.state!.exception![d.state!.exception!.length - 1]
          : d.attempts?.length
            ? d.attempts[d.attempts.length - 1].exception
            : undefined;

      lines.push("");
      lines.push(`<b><a href="${url}">#${tn}</a></b> — ${name}`);
      if (city) lines.push(`📍 ${city}`);
      lines.push(`${typeTag}  ·  <i>${stateVal}</i>`);
      lines.push(hoursLabel);
      if (lastExc?.reason) lines.push(`⚠️ ${lastExc.reason}`);
      if (d.state?.waitingForBusinessAction) lines.push(`🔔 Waiting for your action`);
      if (!isRTO && d.cod) lines.push(`💰 COD: ${d.cod} EGP`);
      if (ref) lines.push(`🔖 ${ref}`);
    }

    const message = lines.join("\n");
    console.log(`[Message] ${message.length} chars`);

    const success = await sendTelegramMessage(message);

    return new Response(
      JSON.stringify({ ok: success, flagged: flagged.length, checked: orders.length }),
      { status: success ? 200 : 500 },
    );
  } catch (err) {
    console.error("[Fatal]", err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
