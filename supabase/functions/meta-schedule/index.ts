/**
 * meta-schedule — persist a future post to the meta_posts queue.
 *
 * Instagram: always queued (no native scheduling API).
 * Facebook:  also queued here for a uniform interface; the process-queue
 *            function will use FB's native scheduled_publish_time when it
 *            processes FB rows, so the actual scheduling is delegated at
 *            publish time.
 *
 * POST /meta-schedule
 * Body:
 * {
 *   platform:     "instagram" | "facebook",
 *   content_type: "post" | "carousel" | "story",
 *   scheduled_at: "2026-05-15T14:00:00Z",   // ISO 8601, UTC
 *   payload:      <IgPayload | FbPayload>
 * }
 *
 * Returns:
 * { success: true, record_id: "<uuid>", scheduled_at: "..." }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ContentType, FbPayload, IgPayload, Platform } from "../_shared/meta-client.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Facebook requires scheduled posts to be at least 10 minutes in the future
const FB_MIN_SCHEDULE_OFFSET_MS = 10 * 60 * 1000;
// and at most 6 months (roughly)
const FB_MAX_SCHEDULE_OFFSET_MS = 6 * 30 * 24 * 60 * 60 * 1000;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: {
    platform: Platform;
    content_type: ContentType;
    scheduled_at: string;
    payload: IgPayload | FbPayload;
  };

  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { platform, content_type, scheduled_at, payload } = body;

  // ── Validation ─────────────────────────────────────────────────────────────
  if (!platform || !content_type || !scheduled_at || !payload) {
    return json(
      {
        error:
          "Missing required fields: platform, content_type, scheduled_at, payload",
      },
      400,
    );
  }

  const validPlatforms: Platform[] = ["instagram", "facebook"];
  const validTypes: ContentType[] = ["post", "carousel", "story"];

  if (!validPlatforms.includes(platform)) {
    return json({ error: `Invalid platform: ${platform}` }, 400);
  }
  if (!validTypes.includes(content_type)) {
    return json({ error: `Invalid content_type: ${content_type}` }, 400);
  }
  if (platform === "instagram" && content_type === "story") {
    // IG stories expire quickly; warn but don't block
    console.warn(
      "Scheduling IG stories far in advance may result in stale content",
    );
  }

  const scheduledDate = new Date(scheduled_at);
  if (isNaN(scheduledDate.getTime())) {
    return json(
      { error: "Invalid scheduled_at: must be a valid ISO 8601 timestamp" },
      400,
    );
  }

  const now = Date.now();
  const diffMs = scheduledDate.getTime() - now;

  if (diffMs <= 0) {
    return json(
      { error: "scheduled_at must be in the future" },
      400,
    );
  }

  if (platform === "facebook") {
    if (diffMs < FB_MIN_SCHEDULE_OFFSET_MS) {
      return json(
        { error: "Facebook posts must be scheduled at least 10 minutes ahead" },
        400,
      );
    }
    if (diffMs > FB_MAX_SCHEDULE_OFFSET_MS) {
      return json(
        { error: "Facebook posts cannot be scheduled more than 6 months ahead" },
        400,
      );
    }
  }

  // ── Persist to queue ───────────────────────────────────────────────────────
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: record, error: insertError } = await supabase
    .schema("meta")
    .from("meta_posts")
    .insert({
      platform,
      content_type,
      scheduled_at: scheduledDate.toISOString(),
      status: "pending",
      payload,
    })
    .select("id, scheduled_at")
    .single();

  if (insertError) {
    console.error("DB insert error:", insertError);
    return json({ error: "Failed to save scheduled post" }, 500);
  }

  return json({
    success: true,
    record_id: record.id,
    platform,
    content_type,
    scheduled_at: record.scheduled_at,
  });
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
