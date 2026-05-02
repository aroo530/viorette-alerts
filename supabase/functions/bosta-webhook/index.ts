import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOSTA_API_KEY = Deno.env.get("BOSTA_API_KEY")!;

type Severity = "critical" | "high" | "medium" | "low" | "info";

interface BostaPayload {
  _id: string;
  trackingNumber: number | string;
  state: number;
  type: string;
  timeStamp: number;
  deliveryPromiseDate?: string;
  numberOfAttempts?: number;
  cod?: number;
  exceptionReason?: string;
  exceptionCode?: number;
  businessReference?: string;
  isConfirmedDelivery?: boolean;
}

interface AlertResult {
  eventType: string;
  severity: Severity;
  message: string;
}

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: "🔴 CRITICAL",
  high: "🟠 HIGH",
  medium: "🟡 MEDIUM",
  low: "🔵 LOW",
  info: "⚪ INFO",
};

// Non-exception states that always alert
const ALERT_STATES = new Set([46, 47, 48, 49, 100, 101, 102, 103, 105]);

function shouldAlert(payload: BostaPayload): boolean {
  return ALERT_STATES.has(payload.state);
}

// Exception code → severity + label
function classifyException(code?: number): {
  severity: Severity;
  label: string;
} {
  if (code == null) return { severity: "medium", label: "Unknown exception" };

  const map: Record<number, { severity: Severity; label: string }> = {
    // Forward exceptions
    1: { severity: "high", label: "Customer not home" },
    2: { severity: "high", label: "Customer changed address" },
    3: { severity: "medium", label: "Customer postponed" },
    4: { severity: "high", label: "Customer wants to inspect shipment" },
    5: { severity: "high", label: "Address or phone unclear/wrong" },
    6: { severity: "high", label: "Canceled by sender" },
    7: { severity: "high", label: "Customer not answering" },
    8: { severity: "high", label: "Customer refused delivery" },
    12: { severity: "high", label: "Address outside Bosta coverage" },
    13: { severity: "high", label: "Address not clear" },
    14: { severity: "high", label: "Wrong phone number" },
    100: { severity: "medium", label: "Bad weather" },
    101: { severity: "critical", label: "Suspicious consignee" },
    // Return exceptions
    20: { severity: "medium", label: "Business changed address (return)" },
    21: { severity: "medium", label: "Business postponed return" },
    22: { severity: "high", label: "Business address/phone unclear (return)" },
    23: { severity: "high", label: "Business not answering (return)" },
    24: { severity: "high", label: "Business refused return" },
    25: { severity: "high", label: "Business not in address (return)" },
    26: { severity: "critical", label: "Damaged shipment" },
    27: { severity: "critical", label: "Empty order" },
    28: { severity: "critical", label: "Incomplete order" },
    29: { severity: "critical", label: "Order does not belong to business" },
    30: {
      severity: "critical",
      label: "Order opened when it should not have been",
    },
  };

  return map[code] ?? { severity: "medium", label: `Exception code ${code}` };
}

function buildAlert(payload: BostaPayload): AlertResult {
  const {
    state,
    trackingNumber,
    type,
    exceptionCode,
    exceptionReason,
    numberOfAttempts,
    cod,
  } = payload;
  const tn = `#${trackingNumber}`;
  const attempts = numberOfAttempts ?? 0;

  const STATE_MAP: Record<number, () => AlertResult> = {
    10: () => ({
      eventType: "pickup_requested",
      severity: "info",
      message: `Pickup requested for ${tn}.`,
    }),
    11: () => ({
      eventType: "waiting_for_route",
      severity: "info",
      message: `${tn} waiting for route (Cash Collection).`,
    }),
    20: () => ({
      eventType: "route_assigned",
      severity: "info",
      message: `Route assigned for ${tn}.`,
    }),
    21: () => ({
      eventType: "picked_up_from_biz",
      severity: "info",
      message: `${tn} picked up from business.`,
    }),
    22: () => ({
      eventType: "pickup_from_consignee",
      severity: "info",
      message: `${tn} heading to consignee for pickup (${type}).`,
    }),
    23: () => ({
      eventType: "picked_up_from_cons",
      severity: "info",
      message: `${tn} picked up from consignee (${type}).`,
    }),
    24: () => ({
      eventType: "received_at_warehouse",
      severity: "info",
      message: `${tn} received at warehouse.`,
    }),
    25: () => ({
      eventType: "shipment_fulfilled",
      severity: "info",
      message: `${tn} fulfilled.`,
    }),
    30: () => ({
      eventType: "in_transit",
      severity: "info",
      message: `${tn} in transit between hubs.`,
    }),
    40: () => ({
      eventType: "picking_up_cash",
      severity: "info",
      message: `${tn} picking up cash from end customer.`,
    }),
    41: () => ({
      eventType: "out_for_delivery",
      severity: "info",
      message: `${tn} out for delivery/return. Attempt ${attempts + 1}.`,
    }),

    45: () => ({
      eventType: "shipment_delivered",
      severity: "info",
      message:
        cod != null
          ? `${tn} delivered. COD collected: ${cod} EGP.`
          : `${tn} delivered successfully.`,
    }),

    46: () => ({
      eventType: "shipment_returned",
      severity: "medium",
      message: `${tn} returned to sender (${type}).`,
    }),
    49: () => ({
      eventType: "shipment_canceled",
      severity: "medium",
      message: `${tn} canceled.`,
    }),
    60: () => ({
      eventType: "returned_to_stock",
      severity: "low",
      message: `${tn} returned to stock.`,
    }),

    47: () => {
      const { severity, label } = classifyException(exceptionCode);
      const reason = exceptionReason ?? label;
      return {
        eventType: "shipment_exception",
        severity,
        message: `${tn} exception (code ${exceptionCode ?? "?"}): ${reason}. Attempts: ${attempts}.`,
      };
    },

    48: () => ({
      eventType: "shipment_terminated",
      severity: "critical",
      message: `${tn} TERMINATED after ${attempts} failed attempts.`,
    }),
    100: () => ({
      eventType: "shipment_lost",
      severity: "critical",
      message: `${tn} marked as LOST.`,
    }),
    101: () => ({
      eventType: "shipment_damaged",
      severity: "critical",
      message: `${tn} marked as DAMAGED.`,
    }),
    102: () => ({
      eventType: "under_investigation",
      severity: "high",
      message: `${tn} under investigation.`,
    }),
    103: () => ({
      eventType: "action_required",
      severity: "high",
      message: `${tn} awaiting your action — return failed after 3 attempts.`,
    }),
    104: () => ({
      eventType: "shipment_archived",
      severity: "low",
      message: `${tn} archived.`,
    }),
    105: () => ({
      eventType: "shipment_on_hold",
      severity: "medium",
      message: `${tn} placed on hold.`,
    }),
  };

  const builder = STATE_MAP[state];
  if (builder) return builder();

  // Unknown state — still alert so nothing is silently dropped
  return {
    eventType: "unknown_state",
    severity: "medium",
    message: `${tn} reached unknown state ${state} (${type}).`,
  };
}

async function fetchOrderDetails(trackingNumber: string | number) {
  try {
    const res = await fetch(
      `https://app.bosta.co/api/v0/deliveries/${trackingNumber}`,
      {
        headers: { Authorization: `${BOSTA_API_KEY}` },
      },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const payload: BostaPayload = await req.json();
    const { eventType, severity, message } = buildAlert(payload);
    const alert = shouldAlert(payload);

    const severityLabel = SEVERITY_EMOJI[severity];
    const fullMessage = `${severityLabel} | ${message}`;

    const [supabase, orderDetails] = await Promise.all([
      Promise.resolve(createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)),
      fetchOrderDetails(payload.trackingNumber),
    ]);

    const { data: inserted, error } = await supabase
      .from("alerts")
      .insert({
        source: "bosta",
        event_type: eventType,
        metric_name: "shipment_state",
        metric_value: payload.state,
        message: fullMessage,
        status: alert ? "pending" : "stored",
        raw_payload: payload,
        order_details: orderDetails,
      })
      .select("id")
      .single();

    if (error) throw error;

    await supabase.from("alert_logs").insert({
      alert_id: inserted.id,
      action: "received",
      channel: null,
      details: {
        source: "bosta_webhook",
        tracking_number: payload.trackingNumber,
        state: payload.state,
        severity,
        exception_code: payload.exceptionCode ?? null,
      },
    });

    return new Response(
      JSON.stringify({
        received: true,
        alert_id: inserted.id,
        event_type: eventType,
        severity,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("bosta-webhook error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
