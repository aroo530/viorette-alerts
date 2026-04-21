#!/bin/bash
# Run this once after filling in .env.example values.
# Usage: cp .env.example .env && nano .env && ./set-secrets.sh

set -e
source .env

supabase secrets set \
  META_ACCESS_TOKEN="$META_ACCESS_TOKEN" \
  AD_ACCOUNT_ID="$AD_ACCOUNT_ID" \
  TWILIO_SID="$TWILIO_SID" \
  TWILIO_AUTH_TOKEN="$TWILIO_AUTH_TOKEN" \
  TWILIO_PHONE="$TWILIO_PHONE" \
  RECIPIENT_PHONE="$RECIPIENT_PHONE" \
  SENDGRID_API_KEY="$SENDGRID_API_KEY" \
  SENDER_EMAIL="$SENDER_EMAIL" \
  RECIPIENT_EMAIL="$RECIPIENT_EMAIL" \
  SLACK_WEBHOOK_URL="$SLACK_WEBHOOK_URL"

echo "All secrets set."
