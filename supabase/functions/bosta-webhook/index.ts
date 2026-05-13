import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const BOSTA_API_KEY = Deno.env.get("BOSTA_API_KEY");
const SEVERITY_EMOJI = {
  critical: "🔴 CRITICAL",
  high: "🟠 HIGH",
  medium: "🟡 MEDIUM",
  low: "🔵 LOW",
  info: "⚪ INFO"
};
// Non-exception states that always alert
const ALERT_STATES = new Set([
  47,
  48,
  49,
  100,
  101,
  102,
  103,
  105
]);
function shouldAlert(payload) {
  return ALERT_STATES.has(payload.state);
}
// Exception code → severity + label
function classifyException(code) {
  if (code == null) return {
    severity: "medium",
    label: "Unknown exception"
  };
  const map = {
    // Forward exceptions
    1: {
      severity: "high",
      label: "Customer not home"
    },
    2: {
      severity: "high",
      label: "Customer changed address"
    },
    3: {
      severity: "medium",
      label: "Customer postponed"
    },
    4: {
      severity: "high",
      label: "Customer wants to inspect shipment"
    },
    5: {
      severity: "high",
      label: "Address or phone unclear/wrong"
    },
    6: {
      severity: "high",
      label: "Canceled by sender"
    },
    7: {
      severity: "high",
      label: "Customer not answering"
    },
    8: {
      severity: "high",
      label: "Customer refused delivery"
    },
    12: {
      severity: "high",
      label: "Address outside Bosta coverage"
    },
    13: {
      severity: "high",
      label: "Address not clear"
    },
    14: {
      severity: "high",
      label: "Wrong phone number"
    },
    100: {
      severity: "medium",
      label: "Bad weather"
    },
    101: {
      severity: "critical",
      label: "Suspicious consignee"
    },
    // Return exceptions
    20: {
      severity: "medium",
      label: "Business changed address (return)"
    },
    21: {
      severity: "medium",
      label: "Business postponed return"
    },
    22: {
      severity: "high",
      label: "Business address/phone unclear (return)"
    },
    23: {
      severity: "high",
      label: "Business not answering (return)"
    },
    24: {
      severity: "high",
      label: "Business refused return"
    },
    25: {
      severity: "high",
      label: "Business not in address (return)"
    },
    26: {
      severity: "critical",
      label: "Damaged shipment"
    },
    27: {
      severity: "critical",
      label: "Empty order"
    },
    28: {
      severity: "critical",
      label: "Incomplete order"
    },
    29: {
      severity: "critical",
      label: "Order does not belong to business"
    },
    30: {
      severity: "critical",
      label: "Order opened when it should not have been"
    }
  };
  return map[code] ?? {
    severity: "medium",
    label: `Exception code ${code}`
  };
}
function buildAlert(payload) {
  const { state, trackingNumber, type, exceptionCode, exceptionReason, numberOfAttempts, cod } = payload;
  const tn = `#${trackingNumber}`;
  const attempts = numberOfAttempts ?? 0;
  const STATE_MAP = {
    10: ()=>({
        eventType: "pickup_requested",
        severity: "info",
        message: `Pickup requested for ${tn}.`
      }),
    11: ()=>({
        eventType: "waiting_for_route",
        severity: "info",
        message: `${tn} waiting for route (Cash Collection).`
      }),
    20: ()=>({
        eventType: "route_assigned",
        severity: "info",
        message: `Route assigned for ${tn}.`
      }),
    21: ()=>({
        eventType: "picked_up_from_biz",
        severity: "info",
        message: `${tn} picked up from business.`
      }),
    22: ()=>({
        eventType: "pickup_from_consignee",
        severity: "info",
        message: `${tn} heading to consignee for pickup (${type}).`
      }),
    23: ()=>({
        eventType: "picked_up_from_cons",
        severity: "info",
        message: `${tn} picked up from consignee (${type}).`
      }),
    24: ()=>({
        eventType: "received_at_warehouse",
        severity: "info",
        message: `${tn} received at warehouse.`
      }),
    25: ()=>({
        eventType: "shipment_fulfilled",
        severity: "info",
        message: `${tn} fulfilled.`
      }),
    30: ()=>({
        eventType: "in_transit",
        severity: "info",
        message: `${tn} in transit between hubs.`
      }),
    40: ()=>({
        eventType: "picking_up_cash",
        severity: "info",
        message: `${tn} picking up cash from end customer.`
      }),
    41: ()=>({
        eventType: "out_for_delivery",
        severity: "info",
        message: `${tn} out for delivery/return. Attempt ${attempts + 1}.`
      }),
    45: ()=>({
        eventType: "shipment_delivered",
        severity: "info",
        message: cod != null ? `${tn} delivered. COD collected: ${cod} EGP.` : `${tn} delivered successfully.`
      }),
    46: ()=>({
        eventType: "shipment_returned",
        severity: "medium",
        message: `${tn} returned to sender (${type}).`
      }),
    49: ()=>({
        eventType: "shipment_canceled",
        severity: "medium",
        message: `${tn} canceled.`
      }),
    60: ()=>({
        eventType: "returned_to_stock",
        severity: "low",
        message: `${tn} returned to stock.`
      }),
    47: ()=>{
      const { severity, label } = classifyException(exceptionCode);
      const reason = exceptionReason ?? label;
      return {
        eventType: "shipment_exception",
        severity,
        message: `${tn} exception (code ${exceptionCode ?? "?"}): ${reason}. Attempts: ${attempts}.`
      };
    },
    48: ()=>({
        eventType: "shipment_terminated",
        severity: "critical",
        message: `${tn} TERMINATED after ${attempts} failed attempts.`
      }),
    100: ()=>({
        eventType: "shipment_lost",
        severity: "critical",
        message: `${tn} marked as LOST.`
      }),
    101: ()=>({
        eventType: "shipment_damaged",
        severity: "critical",
        message: `${tn} marked as DAMAGED.`
      }),
    102: ()=>({
        eventType: "under_investigation",
        severity: "high",
        message: `${tn} under investigation.`
      }),
    103: ()=>({
        eventType: "action_required",
        severity: "high",
        message: `${tn} awaiting your action — return failed after 3 attempts.`
      }),
    104: ()=>({
        eventType: "shipment_archived",
        severity: "low",
        message: `${tn} archived.`
      }),
    105: ()=>({
        eventType: "shipment_on_hold",
        severity: "medium",
        message: `${tn} placed on hold.`
      })
  };
  const builder = STATE_MAP[state];
  if (builder) return builder();
  // Unknown state — still alert so nothing is silently dropped
  return {
    eventType: "unknown_state",
    severity: "medium",
    message: `${tn} reached unknown state ${state} (${type}).`
  };
}
async function fetchOrderDetails(trackingNumber) {
  try {
    const res = await fetch(`https://app.bosta.co/api/v0/deliveries/${trackingNumber}`, {
      headers: {
        Authorization: `${BOSTA_API_KEY}`
      }
    });
    if (!res.ok) return null;
    const d = await res.json();
    const lastException = d.exceptionLog?.at(-1) ?? d.exception ?? null;
    return {
      bosta_id: d._id,
      tracking_number: d.trackingNumber,
      business_reference: d.businessReference,
      type_code: d.type?.code,
      type_value: d.type?.value,
      cod: d.cod,
      shipment_fees: d.shipmentFees,
      attempts_count: d.attemptsCount,
      last_exception_code: lastException?.code ?? null,
      last_exception_reason: lastException?.reason ?? null,
      receiver_name: d.receiver?.fullName,
      receiver_phone: d.receiver?.phone,
      weight: d.specs?.weight,
      package_type: d.specs?.packageType,
      items_count: d.specs?.packageDetails?.itemsCount,
      scheduled_at: d.scheduledAt,
      collected_at: d.collectedFromConsignee,
      created_at: d.createdAt,
      updated_at: d.updatedAt
    };
  } catch  {
    return null;
  }
}
Deno.serve(async (req)=>{
  if (req.method !== "POST") {
    return new Response(JSON.stringify({
      error: "Method not allowed"
    }), {
      status: 405,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
  try {
    const payload = await req.json();
    const { eventType, severity, message } = buildAlert(payload);
    const alert = shouldAlert(payload);
    const severityLabel = SEVERITY_EMOJI[severity];
    const fullMessage = `${severityLabel} | ${message}`;
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    // Insert immediately so nothing is dropped — dispatch is held until enrichment
    const { data: inserted, error } = await supabase.from("alerts").insert({
      source: "bosta",
      event_type: eventType,
      metric_name: "shipment_state",
      metric_value: payload.state,
      message: fullMessage,
      status: alert ? "enriching" : "stored",
      raw_payload: payload
    }).select("id").single();
    if (error) throw error;
    // Respond to Bosta immediately — enrichment runs in the background
    EdgeRuntime.waitUntil((async ()=>{
      const [orderDetails] = await Promise.all([
        fetchOrderDetails(payload.trackingNumber),
        supabase.from("alert_logs").insert({
          alert_id: inserted.id,
          action: "received",
          channel: null,
          details: {
            source: "bosta_webhook",
            tracking_number: payload.trackingNumber,
            state: payload.state,
            severity,
            exception_code: payload.exceptionCode ?? null
          }
        })
      ]);
      let orderId = null;
      if (orderDetails?.bosta_id) {
        const { data: orderRow } = await supabase.from("bosta_orders").upsert({
          bosta_id: orderDetails.bosta_id,
          tracking_number: String(orderDetails.tracking_number ?? payload.trackingNumber),
          business_reference: orderDetails.business_reference ?? null,
          type_code: orderDetails.type_code ?? null,
          type_value: orderDetails.type_value ?? null,
          cod: orderDetails.cod ?? null,
          shipment_fees: orderDetails.shipment_fees ?? null,
          attempts_count: orderDetails.attempts_count ?? null,
          last_exception_code: orderDetails.last_exception_code ?? null,
          last_exception_reason: orderDetails.last_exception_reason ?? null,
          receiver_name: orderDetails.receiver_name ?? null,
          receiver_phone: orderDetails.receiver_phone ?? null,
          weight: orderDetails.weight ?? null,
          package_type: orderDetails.package_type ?? null,
          items_count: orderDetails.items_count ?? null,
          scheduled_at: orderDetails.scheduled_at ?? null,
          collected_at: orderDetails.collected_at ?? null,
          bosta_created_at: orderDetails.created_at ?? null,
          bosta_updated_at: orderDetails.updated_at ?? null,
          synced_at: new Date().toISOString()
        }, {
          onConflict: "bosta_id",
          ignoreDuplicates: false
        }).select("id").single();
        orderId = orderRow?.id ?? null;
      }
      // Flip to pending — this UPDATE fires the dispatch trigger
      await supabase.from("alerts").update({
        order_id: orderId,
        status: alert ? "pending" : "stored"
      }).eq("id", inserted.id);
    })());
    return new Response(JSON.stringify({
      received: true,
      alert_id: inserted.id,
      event_type: eventType,
      severity
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  } catch (err) {
    console.error("bosta-webhook error:", err);
    return new Response(JSON.stringify({
      error: err.message
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
});
