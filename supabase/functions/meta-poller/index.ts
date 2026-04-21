import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const META_ACCESS_TOKEN = Deno.env.get('META_ACCESS_TOKEN')!
const AD_ACCOUNT_ID = Deno.env.get('AD_ACCOUNT_ID')!

const THRESHOLDS = {
  cpc:         { max: 2.5 },
  cpm:         { max: 15.0 },
  ctr:         { min: 0.8 },
  roas:        { min: 3.0 },
  daily_spend: { max: 500 },
}

interface AlertCandidate {
  source: string
  event_type: string
  metric_name: string
  metric_value: number
  threshold_value: number
  threshold_operator: string
  message: string
  status: string
  raw_payload: unknown
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 })
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    const today = new Date().toISOString().split('T')[0]

    const url =
      `https://graph.facebook.com/v18.0/${AD_ACCOUNT_ID}/insights` +
      `?fields=spend,cpc,cpm,ctr,action_values` +
      `&time_range={"since":"${today}","until":"${today}"}` +
      `&access_token=${META_ACCESS_TOKEN}`

    const res = await fetch(url)
    const data = await res.json()

    if (!res.ok || data.error) {
      throw new Error(`Meta API error: ${data.error?.message ?? res.statusText}`)
    }

    const insights: Record<string, number> = {}
    for (const row of data.data ?? []) {
      if (row.spend    != null) insights.spend         = parseFloat(row.spend)
      if (row.cpc      != null) insights.cpc           = parseFloat(row.cpc)
      if (row.cpm      != null) insights.cpm           = parseFloat(row.cpm)
      if (row.ctr      != null) insights.ctr           = parseFloat(row.ctr)
      if (row.action_values != null) {
        const purchase = (row.action_values as Array<{action_type:string,value:string}>)
          .find(a => a.action_type === 'purchase')
        if (purchase) insights.roas = parseFloat(purchase.value) / (insights.spend || 1)
      }
    }

    const alerts: AlertCandidate[] = []

    if (insights.cpc > THRESHOLDS.cpc.max) {
      alerts.push({
        source: 'meta', event_type: 'cpc_spike',
        metric_name: 'cpc', metric_value: insights.cpc,
        threshold_value: THRESHOLDS.cpc.max, threshold_operator: 'greater_than',
        message: `CPC spike: $${insights.cpc.toFixed(2)} (threshold: $${THRESHOLDS.cpc.max})`,
        status: 'pending', raw_payload: data,
      })
    }

    if (insights.cpm > THRESHOLDS.cpm.max) {
      alerts.push({
        source: 'meta', event_type: 'cpm_spike',
        metric_name: 'cpm', metric_value: insights.cpm,
        threshold_value: THRESHOLDS.cpm.max, threshold_operator: 'greater_than',
        message: `CPM spike: $${insights.cpm.toFixed(2)} (threshold: $${THRESHOLDS.cpm.max})`,
        status: 'pending', raw_payload: data,
      })
    }

    if (insights.ctr != null && insights.ctr < THRESHOLDS.ctr.min) {
      alerts.push({
        source: 'meta', event_type: 'ctr_drop',
        metric_name: 'ctr', metric_value: insights.ctr,
        threshold_value: THRESHOLDS.ctr.min, threshold_operator: 'less_than',
        message: `CTR drop: ${insights.ctr.toFixed(2)}% (threshold: ${THRESHOLDS.ctr.min}%)`,
        status: 'pending', raw_payload: data,
      })
    }

    if (insights.roas != null && insights.roas < THRESHOLDS.roas.min) {
      alerts.push({
        source: 'meta', event_type: 'roas_drop',
        metric_name: 'roas', metric_value: insights.roas,
        threshold_value: THRESHOLDS.roas.min, threshold_operator: 'less_than',
        message: `ROAS drop: ${insights.roas.toFixed(2)}x (threshold: ${THRESHOLDS.roas.min}x)`,
        status: 'pending', raw_payload: data,
      })
    }

    if (insights.spend > THRESHOLDS.daily_spend.max) {
      alerts.push({
        source: 'meta', event_type: 'spend_overage',
        metric_name: 'daily_spend', metric_value: insights.spend,
        threshold_value: THRESHOLDS.daily_spend.max, threshold_operator: 'greater_than',
        message: `Daily spend exceeded: $${insights.spend.toFixed(2)} (limit: $${THRESHOLDS.daily_spend.max})`,
        status: 'pending', raw_payload: data,
      })
    }

    if (alerts.length > 0) {
      const { error } = await supabase.from('alerts').insert(alerts)
      if (error) throw error
    }

    return new Response(
      JSON.stringify({ metrics_checked: Object.keys(insights).length, alerts_triggered: alerts.length }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    console.error('meta-poller error:', err)
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
