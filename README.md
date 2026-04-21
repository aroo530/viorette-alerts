# Viorette Alerts

Real-time operations monitoring for [Viorette](https://viorette.com) — tracks Bosta shipments and Meta Ads performance, then pushes alerts to Telegram, WhatsApp, Email, and Slack.

Built on **Supabase Edge Functions** (Deno) with **pg_cron** for scheduled reports.

---

## What it does

### Bosta shipment tracking
- **Webhook listener** (`bosta-webhook`) — receives every state change from Bosta, classifies it by severity, and stores it in the `alerts` table
- **Daily report** (`bosta-daily-report`) — pulls all active orders directly from the Bosta API 4× a day and sends a formatted summary to Telegram, so you get the full picture even if a webhook was missed

### Meta Ads monitoring
- **Poller** (`meta-poller`) — checks today's CPC, CPM, CTR, ROAS, and daily spend against configurable thresholds and fires alerts when any threshold is breached

### Alert dispatch
- **Dispatcher** (`dispatch-alert`) — picks up pending alerts and fans them out to all four channels in parallel: Telegram, WhatsApp (Twilio), Email (SendGrid), and Slack

---

## Architecture

```
Bosta webhooks ──► bosta-webhook ──► alerts table ──► dispatch-alert ──► Telegram
                                                                      ──► WhatsApp
Meta Ads API ────► meta-poller ───► alerts table ──► dispatch-alert ──► Email
                                                                      ──► Slack

pg_cron (4×/day) ► bosta-daily-report ──────────────────────────────► Telegram
```

The `alerts` table acts as an audit queue — every event is persisted with its raw payload, dispatch status per channel, and a full `alert_logs` trail.

---

## Daily report schedule (Cairo time, UTC+2)

| Check | Cairo | UTC | Content |
|-------|-------|-----|---------|
| 1 — Morning | 10:00 | 08:00 | Full totals + problematic orders |
| 2 — Midday | 12:30 | 10:30 | Active orders with full detail blocks |
| 3 — Afternoon | 15:00 | 13:00 | Multi-attempt & exception orders |
| 4 — End of Day | 17:00 | 15:00 | Daily summary + all outstanding orders |

Each outstanding order renders as a multi-line block:

```
#74307963 — Customer Name
📍 Cairo
↩️ Return to Origin  ·  Received at warehouse  ·  1 attempt(s)
⚠️ Customer refused delivery
🔔 Waiting for your action
📅 Next: 22 Apr
💰 COD: 450 EGP
🔖 #ORDER-REF
```

---

## Project structure

```
supabase/
├── functions/
│   ├── bosta-webhook/        # Receives Bosta state-change events
│   ├── bosta-daily-report/   # 4× daily order report → Telegram
│   ├── dispatch-alert/       # Fans out pending alerts to all channels
│   └── meta-poller/          # Polls Meta Ads API for threshold breaches
└── migrations/
    ├── 20260421071913_create_alerts_tables.sql
    ├── 20260421075726_trigger_dispatch_on_alert.sql
    ├── 20260421080022_fix_dispatch_trigger_function.sql
    ├── 20260421080122_enable_pg_net.sql
    ├── 20260421080325_fix_trigger_use_vault.sql
    ├── 20260421081027_add_telegram_columns.sql
    ├── 20260421084012_add_order_details_column.sql
    └── 20260421090000_schedule_daily_reports.sql
```

---

## Setup

### Prerequisites
- [Supabase CLI](https://supabase.com/docs/guides/cli)
- A Supabase project with `pg_cron` and `pg_net` extensions enabled
- Bosta business account with API key
- Telegram bot + chat ID
- (Optional) Twilio, SendGrid, Slack for additional channels

### 1. Link your Supabase project

```bash
supabase login
supabase link --project-ref <your-project-ref>
```

### 2. Set secrets

```bash
cp .env.example .env
# Fill in your values, then:
./set-secrets.sh
```

You also need to set the Bosta and Telegram secrets:

```bash
supabase secrets set \
  BOSTA_API_KEY="your-bosta-api-key" \
  TELEGRAM_BOT_TOKEN="your-bot-token" \
  TELEGRAM_CHAT_ID="your-chat-id"
```

### 3. Store Vault secrets for pg_cron

The daily report cron jobs read `project_url` and `service_role_key` from Supabase Vault. Add them via the Supabase dashboard under **Settings → Vault**, or with SQL:

```sql
select vault.create_secret('https://<ref>.supabase.co', 'project_url');
select vault.create_secret('<service-role-key>', 'service_role_key');
```

### 4. Run migrations

```bash
supabase db push
```

This creates the `alerts` and `alert_logs` tables, sets up the dispatch trigger, enables `pg_net`, and schedules the 4 daily cron jobs.

### 5. Deploy functions

```bash
supabase functions deploy bosta-webhook
supabase functions deploy bosta-daily-report
supabase functions deploy dispatch-alert
supabase functions deploy meta-poller
```

### 6. Configure Bosta webhook

In the Bosta business dashboard, set your webhook URL to:

```
https://<your-project-ref>.supabase.co/functions/v1/bosta-webhook
```

---

## Testing

Trigger a manual report (check 4 = end-of-day summary):

```bash
supabase functions invoke bosta-daily-report --data '{"check":4}'
```

Trigger the Meta poller:

```bash
supabase functions invoke meta-poller --data '{}'
```

Verify cron jobs are active:

```sql
select jobname, schedule, active from cron.job;
```

---

## Environment variables

| Variable | Used by | Description |
|----------|---------|-------------|
| `BOSTA_API_KEY` | webhook, daily-report | Bosta API key |
| `TELEGRAM_BOT_TOKEN` | daily-report, dispatch | Telegram bot token |
| `TELEGRAM_CHAT_ID` | daily-report, dispatch | Target chat or group ID |
| `TWILIO_SID` | dispatch | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | dispatch | Twilio auth token |
| `TWILIO_PHONE` | dispatch | Twilio WhatsApp sender number |
| `RECIPIENT_PHONE` | dispatch | WhatsApp recipient number |
| `SENDGRID_API_KEY` | dispatch | SendGrid API key |
| `SENDER_EMAIL` | dispatch | Verified sender email |
| `RECIPIENT_EMAIL` | dispatch | Alert recipient email |
| `SLACK_WEBHOOK_URL` | dispatch | Slack incoming webhook URL |
| `META_ACCESS_TOKEN` | meta-poller | Meta Ads access token (valid 60 days) |
| `AD_ACCOUNT_ID` | meta-poller | Meta ad account ID (`act_xxxxx`) |
| `SUPABASE_URL` | webhook, dispatch, poller | Auto-injected in Edge Functions |
| `SUPABASE_SERVICE_ROLE_KEY` | webhook, dispatch, poller | Auto-injected in Edge Functions |

---

## Meta Ads thresholds

Defaults in `meta-poller/index.ts` — edit to match your targets:

| Metric | Default threshold |
|--------|-------------------|
| CPC | > $2.50 |
| CPM | > $15.00 |
| CTR | < 0.8% |
| ROAS | < 3.0× |
| Daily spend | > $500 |
