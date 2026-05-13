/**
 * meta-process-queue — cron-triggered worker that processes due meta_posts.
 *
 * Triggered by pg_cron every minute (or via manual POST for testing).
 *
 * For each due pending post:
 *   Instagram: create container → poll until FINISHED → publish
 *   Facebook:  pass scheduled_publish_time to Graph API (native scheduling)
 *              — the post appears in FB's queue; no further action needed.
 *
 * Rows in "processing" state older than PROCESSING_TIMEOUT_MS are also
 * retried (handles edge-function crashes mid-flight).
 *
 * Failed rows are retried up to max_attempts before being marked "failed".
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  ContentType,
  createMetaClient,
  FbCarouselPayload,
  FbPayload,
  FbPostPayload,
  IgPayload,
  Platform,
} from "../_shared/meta-client.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Rows stuck in "processing" for longer than this are re-tried
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

// Max posts to process per invocation (prevents timeout on large backlogs)
const BATCH_SIZE = 10;

interface MetaPostRow {
  id: string;
  platform: Platform;
  content_type: ContentType;
  scheduled_at: string;
  status: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
  ig_container_id: string | null;
}

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

  // Accept GET (from pg_cron net.http_get) or POST
  if (req.method !== "POST" && req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const meta = createMetaClient();
  const now = new Date();
  const processingCutoff = new Date(now.getTime() - PROCESSING_TIMEOUT_MS);

  // ── Fetch due posts ────────────────────────────────────────────────────────
  // Include rows that are:
  //   (a) pending and scheduled_at <= now
  //   (b) processing but started too long ago (crash recovery)
  const { data: rows, error: fetchError } = await supabase
    .schema("meta")
    .from("meta_posts")
    .select(
      "id, platform, content_type, scheduled_at, status, payload, attempt_count, max_attempts, ig_container_id",
    )
    .or(
      `and(status.eq.pending,scheduled_at.lte.${now.toISOString()}),` +
        `and(status.eq.processing,last_attempted_at.lte.${processingCutoff.toISOString()})`,
    )
    .order("scheduled_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (fetchError) {
    console.error("Failed to fetch due posts:", fetchError);
    return json({ error: "DB fetch error", detail: fetchError.message }, 500);
  }

  if (!rows || rows.length === 0) {
    return json({ processed: 0, message: "No due posts" });
  }

  const results: Array<{
    id: string;
    status: "published" | "failed" | "retrying";
    error?: string;
  }> = [];

  for (const row of rows as MetaPostRow[]) {
    // Mark as processing + increment attempt
    await supabase
      .schema("meta")
      .from("meta_posts")
      .update({
        status: "processing",
        attempt_count: row.attempt_count + 1,
        last_attempted_at: now.toISOString(),
      })
      .eq("id", row.id);

    try {
      if (row.platform === "instagram") {
        await processInstagram(meta, supabase, row);
      } else {
        await processFacebook(meta, supabase, row);
      }

      results.push({ id: row.id, status: "published" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Failed post ${row.id}:`, message);

      const nextAttempt = row.attempt_count + 1;
      const exhausted = nextAttempt >= row.max_attempts;

      await supabase
        .schema("meta")
        .from("meta_posts")
        .update({
          status: exhausted ? "failed" : "pending",
          last_error: message,
        })
        .eq("id", row.id);

      results.push({
        id: row.id,
        status: exhausted ? "failed" : "retrying",
        error: message,
      });
    }
  }

  const published = results.filter((r) => r.status === "published").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const retrying = results.filter((r) => r.status === "retrying").length;

  return json({ processed: rows.length, published, failed, retrying, results });
});

// ── Instagram processor ──────────────────────────────────────────────────────

async function processInstagram(
  meta: ReturnType<typeof createMetaClient>,
  supabase: ReturnType<typeof createClient>,
  row: MetaPostRow,
) {
  // Containers expire in 24 h, so always create a fresh one at publish time.
  // We intentionally ignore any previously stored ig_container_id.
  const { containerId, mediaId } = await meta.publishInstagram(
    row.content_type,
    row.payload as unknown as IgPayload,
  );

  await supabase
    .schema("meta")
    .from("meta_posts")
    .update({
      status: "published",
      ig_container_id: containerId,
      ig_media_id: mediaId,
      graph_response: { containerId, mediaId },
      last_error: null,
    })
    .eq("id", row.id);
}

// ── Facebook processor ───────────────────────────────────────────────────────

async function processFacebook(
  meta: ReturnType<typeof createMetaClient>,
  supabase: ReturnType<typeof createClient>,
  row: MetaPostRow,
) {
  const scheduledAt = new Date(row.scheduled_at);
  const now = new Date();

  // If the post is still in the future, use FB native scheduling.
  // If scheduled_at has already passed (or is within 10 min), publish immediately.
  const FB_MIN_OFFSET_MS = 10 * 60 * 1000;
  const useNativeScheduling =
    scheduledAt.getTime() - now.getTime() > FB_MIN_OFFSET_MS;

  let payload = row.payload as unknown as FbPayload;

  if (useNativeScheduling) {
    const unixTs = Math.floor(scheduledAt.getTime() / 1000);
    // Inject scheduled_publish_time into the payload copy
    payload = {
      ...payload,
      scheduled_publish_time: unixTs,
    } as FbPostPayload | FbCarouselPayload;
  }

  const result = await meta.publishFacebook(row.content_type, payload);

  await supabase
    .schema("meta")
    .from("meta_posts")
    .update({
      status: "published",
      fb_post_id: result.postId,
      graph_response: result,
      last_error: null,
    })
    .eq("id", row.id);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
