import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const META_ACCESS_TOKEN = Deno.env.get("META_ACCESS_TOKEN")!;
const AD_ACCOUNT_ID = Deno.env.get("AD_ACCOUNT_ID")!;
const DAILY_AD_BUDGET = parseFloat(Deno.env.get("DAILY_AD_BUDGET") ?? "0");

const THRESHOLDS = {
  cost_per_purchase: { max: 13 },
  cpm: { max: 8 },
  frequency: { max: 3.0 },
  ctr: { min: 1.0 },
};

interface AlertCandidate {
  source: string;
  event_type: string;
  metric_name: string;
  metric_value: number;
  threshold_value: number;
  threshold_operator: string;
  message: string;
  status: string;
  raw_payload: unknown;
}

type ActionRow = { action_type: string; value: string };

function insightsUrl(since: string, until: string, fields: string): string {
  return (
    `https://graph.facebook.com/v18.0/${AD_ACCOUNT_ID}/insights` +
    `?fields=${fields}` +
    `&time_range=${JSON.stringify({ since, until })}` +
    `&access_token=${META_ACCESS_TOKEN}`
  );
}

function sumPurchases(data: unknown[]): number {
  let total = 0;
  for (const row of data) {
    const r = row as Record<string, unknown>;
    if (Array.isArray(r.actions)) {
      const purchase = (r.actions as ActionRow[]).find(
        (a) => a.action_type === "purchase",
      );
      if (purchase) total += parseFloat(purchase.value);
    }
  }
  return total;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
    });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().split("T")[0];

    const [todayRes, fortyEightHrRes] = await Promise.all([
      fetch(
        insightsUrl(
          todayStr,
          todayStr,
          "spend,cpm,ctr,frequency,actions,action_values",
        ),
      ),
      fetch(insightsUrl(yesterdayStr, todayStr, "spend,actions")),
    ]);

    const [todayData, fortyEightHrData] = await Promise.all([
      todayRes.json(),
      fortyEightHrRes.json(),
    ]);

    if (!todayRes.ok || todayData.error) {
      throw new Error(
        `Meta API error: ${todayData.error?.message ?? todayRes.statusText}`,
      );
    }

    const insights: Record<string, number> = {};
    for (const row of todayData.data ?? []) {
      const r = row as Record<string, unknown>;
      if (r.spend != null) insights.spend = parseFloat(r.spend as string);
      if (r.cpm != null) insights.cpm = parseFloat(r.cpm as string);
      if (r.ctr != null) insights.ctr = parseFloat(r.ctr as string);
      if (r.frequency != null)
        insights.frequency = parseFloat(r.frequency as string);
      if (Array.isArray(r.actions)) {
        const purchase = (r.actions as ActionRow[]).find(
          (a) => a.action_type === "purchase",
        );
        if (purchase) insights.purchase_count = parseFloat(purchase.value);
      }
    }

    if (
      insights.spend != null &&
      insights.purchase_count != null &&
      insights.purchase_count > 0
    ) {
      insights.cost_per_purchase = insights.spend / insights.purchase_count;
    }

    const fortyEightHrPurchases = sumPurchases(fortyEightHrData.data ?? []);
    const hasSpend = (insights.spend ?? 0) > 0;

    const alerts: AlertCandidate[] = [];

    // Cost per purchase > $13 — pause immediately
    if (
      insights.cost_per_purchase != null &&
      insights.cost_per_purchase > THRESHOLDS.cost_per_purchase.max
    ) {
      alerts.push({
        source: "meta",
        event_type: "cost_per_purchase_spike",
        metric_name: "cost_per_purchase",
        metric_value: insights.cost_per_purchase,
        threshold_value: THRESHOLDS.cost_per_purchase.max,
        threshold_operator: "greater_than",
        message: `Cost per purchase: $${insights.cost_per_purchase.toFixed(2)} (limit: $${THRESHOLDS.cost_per_purchase.max}) — pause the ad immediately`,
        status: "pending",
        raw_payload: todayData,
      });
    }

    // CPM > $8 — check if seasonal or creative fatigue
    if (insights.cpm != null && insights.cpm > THRESHOLDS.cpm.max) {
      alerts.push({
        source: "meta",
        event_type: "cpm_spike",
        metric_name: "cpm",
        metric_value: insights.cpm,
        threshold_value: THRESHOLDS.cpm.max,
        threshold_operator: "greater_than",
        message: `CPM spike: $${insights.cpm.toFixed(2)} (threshold: $${THRESHOLDS.cpm.max}) — check if seasonal or creative fatigue`,
        status: "pending",
        raw_payload: todayData,
      });
    }

    // Frequency > 3.0 — creative fatigued, flag marketer
    if (
      insights.frequency != null &&
      insights.frequency > THRESHOLDS.frequency.max
    ) {
      alerts.push({
        source: "meta",
        event_type: "frequency_too_high",
        metric_name: "frequency",
        metric_value: insights.frequency,
        threshold_value: THRESHOLDS.frequency.max,
        threshold_operator: "greater_than",
        message: `Ad frequency: ${insights.frequency.toFixed(2)} (limit: ${THRESHOLDS.frequency.max}) — creative fatigued, flag marketer to swap today`,
        status: "pending",
        raw_payload: todayData,
      });
    }

    // Daily spend > 110% of budget — check for delivery errors
    if (
      DAILY_AD_BUDGET > 0 &&
      insights.spend != null &&
      insights.spend > DAILY_AD_BUDGET * 1.1
    ) {
      const limit = DAILY_AD_BUDGET * 1.1;
      alerts.push({
        source: "meta",
        event_type: "spend_overage",
        metric_name: "daily_spend",
        metric_value: insights.spend,
        threshold_value: limit,
        threshold_operator: "greater_than",
        message: `Daily spend overage: $${insights.spend.toFixed(2)} (110% of $${DAILY_AD_BUDGET} budget = $${limit.toFixed(2)}) — check for budget delivery errors`,
        status: "pending",
        raw_payload: todayData,
      });
    }

    // CTR < 1% — creative not resonating
    if (insights.ctr != null && insights.ctr < THRESHOLDS.ctr.min) {
      alerts.push({
        source: "meta",
        event_type: "ctr_drop",
        metric_name: "ctr",
        metric_value: insights.ctr,
        threshold_value: THRESHOLDS.ctr.min,
        threshold_operator: "less_than",
        message: `CTR: ${insights.ctr.toFixed(2)}% (threshold: ${THRESHOLDS.ctr.min}%) — creative not resonating, replace within 48h`,
        status: "pending",
        raw_payload: todayData,
      });
    }

    // 0 purchases in 48h (only alert if there's active spend)
    if (hasSpend && fortyEightHrPurchases === 0) {
      alerts.push({
        source: "meta",
        event_type: "zero_purchases_48h",
        metric_name: "purchase_count_48h",
        metric_value: 0,
        threshold_value: 1,
        threshold_operator: "less_than",
        message: `0 purchases in the last 48 hours despite active spend — pause and review targeting + creative, escalate to marketer`,
        status: "pending",
        raw_payload: fortyEightHrData,
      });
    }

    if (alerts.length > 0) {
      const { error } = await supabase.from("alerts").insert(alerts);
      if (error) throw error;
    }

    return new Response(
      JSON.stringify({
        metrics_checked: Object.keys(insights).length,
        alerts_triggered: alerts.length,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("meta-poller error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
