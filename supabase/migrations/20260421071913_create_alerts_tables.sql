-- alerts: queue table for all triggered alerts
CREATE TABLE alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamp with time zone DEFAULT now(),

  source text NOT NULL,
  event_type text NOT NULL,

  metric_name text,
  metric_value numeric,
  threshold_value numeric,
  threshold_operator text,
  message text NOT NULL,

  status text NOT NULL DEFAULT 'pending',
  dispatched_at timestamp with time zone,

  raw_payload jsonb,

  whatsapp_status text DEFAULT 'pending',
  whatsapp_error text,
  email_status text DEFAULT 'pending',
  email_error text,
  slack_status text DEFAULT 'pending',
  slack_error text
);

CREATE INDEX idx_alerts_status ON alerts(status);
CREATE INDEX idx_alerts_source ON alerts(source);
CREATE INDEX idx_alerts_created_at ON alerts(created_at DESC);

-- alert_logs: audit trail for every action on an alert
CREATE TABLE alert_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamp with time zone DEFAULT now(),

  alert_id uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  action text NOT NULL,
  channel text,

  details jsonb,
  error_message text
);

CREATE INDEX idx_logs_alert_id ON alert_logs(alert_id);
CREATE INDEX idx_logs_created_at ON alert_logs(created_at DESC);
