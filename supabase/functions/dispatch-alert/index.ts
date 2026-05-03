import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TWILIO_SID = Deno.env.get("TWILIO_SID")!;
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN")!;
const TWILIO_PHONE = Deno.env.get("TWILIO_PHONE")!;
const RECIPIENT_PHONE = Deno.env.get("RECIPIENT_PHONE")!;

const SENDGRID_API_KEY = Deno.env.get("SENDGRID_API_KEY")!;
const SENDER_EMAIL = Deno.env.get("SENDER_EMAIL")!;
const RECIPIENT_EMAIL = Deno.env.get("RECIPIENT_EMAIL")!;

const SLACK_WEBHOOK_URL = Deno.env.get("SLACK_WEBHOOK_URL")!;

const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_CHAT_ID = Deno.env.get("TELEGRAM_CHAT_ID")!;

interface BostaOrder {
  bosta_id?: string;
  tracking_number?: string | number;
  business_reference?: string;
  state_code?: number;
  state_value?: string;
  type_code?: number;
  type_value?: string;
  cod?: number;
  shipment_fees?: number;
  attempts_count?: number;
  last_exception_code?: number;
  last_exception_reason?: string;
  receiver_name?: string;
  receiver_phone?: string;
  weight?: number;
  package_type?: string;
  items_count?: number;
  scheduled_at?: string;
  collected_at?: string;
  created_at?: string;
  updated_at?: string;
}

interface Alert {
  id: string;
  source: string;
  event_type: string;
  message: string;
  created_at: string;
  raw_payload?: { trackingNumber?: string | number; [key: string]: unknown };
  order_details?: BostaOrder;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const body = await req.json().catch(() => ({}));
  const alertId: string | undefined = body.alert_id;

  const query = supabase.from("alerts").select("*").eq("status", "pending");
  const { data: alerts, error: fetchError } = alertId
    ? await query.eq("id", alertId).limit(1)
    : await query.limit(10);

  if (fetchError) {
    return new Response(JSON.stringify({ error: fetchError.message }), {
      status: 500,
    });
  }

  if (!alerts || alerts.length === 0) {
    return new Response(JSON.stringify({ dispatched: 0 }), { status: 200 });
  }

  let dispatched = 0;

  for (const alert of alerts as Alert[]) {
    const channelUpdates: Record<string, string> = {};

    const [wa, em, sl, tg] = await Promise.allSettled([
      sendWhatsApp(alert),
      sendEmail(alert),
      sendSlack(alert),
      sendTelegram(alert),
    ]);

    channelUpdates.whatsapp_status =
      wa.status === "fulfilled" ? "sent" : "failed";
    channelUpdates.email_status = em.status === "fulfilled" ? "sent" : "failed";
    channelUpdates.slack_status = sl.status === "fulfilled" ? "sent" : "failed";
    channelUpdates.telegram_status =
      tg.status === "fulfilled" ? "sent" : "failed";

    if (wa.status === "rejected")
      channelUpdates.whatsapp_error = (wa.reason as Error).message;
    if (em.status === "rejected")
      channelUpdates.email_error = (em.reason as Error).message;
    if (sl.status === "rejected")
      channelUpdates.slack_error = (sl.reason as Error).message;
    if (tg.status === "rejected")
      channelUpdates.telegram_error = (tg.reason as Error).message;

    const allFailed =
      channelUpdates.whatsapp_status === "failed" &&
      channelUpdates.email_status === "failed" &&
      channelUpdates.slack_status === "failed" &&
      channelUpdates.telegram_status === "failed";

    await supabase
      .from("alerts")
      .update({
        status: allFailed ? "failed" : "dispatched",
        dispatched_at: new Date().toISOString(),
        ...channelUpdates,
      })
      .eq("id", alert.id);

    await supabase.from("alert_logs").insert({
      alert_id: alert.id,
      action: allFailed ? "failed" : "dispatched",
      details: channelUpdates,
    });

    if (!allFailed) dispatched++;
  }

  return new Response(JSON.stringify({ dispatched, total: alerts.length }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

async function sendWhatsApp(alert: Alert): Promise<void> {
  const auth = btoa(`${TWILIO_SID}:${TWILIO_AUTH_TOKEN}`);
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        From: `whatsapp:${TWILIO_PHONE}`,
        To: `whatsapp:${RECIPIENT_PHONE}`,
        Body: alert.message,
      }).toString(),
    },
  );
  if (!res.ok) throw new Error(`WhatsApp failed: ${await res.text()}`);
}

async function sendEmail(alert: Alert): Promise<void> {
  const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: RECIPIENT_EMAIL }] }],
      from: { email: SENDER_EMAIL },
      subject: `[Viorette Alert] ${alert.event_type}`,
      content: [
        {
          type: "text/html",
          value: `<h2>${alert.event_type}</h2><p>${alert.message}</p><p><small>Source: ${alert.source} | ${alert.created_at}</small></p>`,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Email failed: ${await res.text()}`);
}

function formatTelegramMessage(
  alert: Alert,
  order?: BostaOrder | null,
): string {
  const title = alert.event_type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

  const [severityPart, ...bodyParts] = alert.message.split(" | ");
  const body = bodyParts.length ? bodyParts.join(" | ") : alert.message;

  const date = new Date(alert.created_at);
  const timestamp =
    date.toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Africa/Cairo",
    }) + " (Cairo)";

  const lines = [`${severityPart}  ·  <b>${title}</b>`, "", body];

  if (order) {
    const pkg = [
      order.items_count != null ? `${order.items_count} item(s)` : null,
      order.package_type,
    ]
      .filter(Boolean)
      .join(" · ");

    lines.push("");
    if (order.receiver_name)  lines.push(`👤 ${order.receiver_name}`);
    if (order.receiver_phone) lines.push(`📞 ${order.receiver_phone}`);
    if (order.business_reference) lines.push(`🔖 ${order.business_reference}`);
    if (order.cod != null)    lines.push(`💰 COD: ${order.cod} EGP`);
    if (order.shipment_fees != null) lines.push(`🧾 Fees: ${order.shipment_fees} EGP`);
    if (pkg)                  lines.push(`📦 ${pkg}`);
    if (order.attempts_count != null) lines.push(`🔄 Attempts: ${order.attempts_count}`);
    if (order.last_exception_reason) lines.push(`⚠️ ${order.last_exception_reason}`);
  }

  lines.push("", `<i>🕐 ${timestamp}</i>`);
  return lines.join("\n");
}

async function sendTelegram(alert: Alert): Promise<void> {
  const trackingNumber = alert.raw_payload?.trackingNumber;
  const order = alert.order_details;

  const payload: Record<string, unknown> = {
    chat_id: TELEGRAM_CHAT_ID,
    text: formatTelegramMessage(alert, order),
    parse_mode: "HTML",
  };

  if (trackingNumber) {
    payload.reply_markup = {
      inline_keyboard: [
        [
          {
            text: "📦 Track Order",
            url: `https://business.bosta.co/orders/${trackingNumber}`,
          },
        ],
      ],
    };
  }

  const res = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) throw new Error(`Telegram failed: ${await res.text()}`);
}

async function sendSlack(alert: Alert): Promise<void> {
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: alert.event_type },
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: alert.message },
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `Source: *${alert.source}* | ${alert.created_at}`,
            },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Slack failed: ${await res.text()}`);
}
