/**
 * meta-publish — immediate publish to Instagram or Facebook.
 *
 * POST /meta-publish
 * Body:
 * {
 *   platform:     "instagram" | "facebook",
 *   content_type: "post" | "carousel" | "story",
 *   payload:      <IgPayload | FbPayload>
 * }
 *
 * Returns:
 * { success: true, platform, mediaId? | postId?, containerId? }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  ContentType,
  createMetaClient,
  FbPayload,
  IgPayload,
  Platform,
} from "../_shared/meta-client.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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
    payload: IgPayload | FbPayload;
  };

  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { platform, content_type, payload } = body;

  if (!platform || !content_type || !payload) {
    return json(
      { error: "Missing required fields: platform, content_type, payload" },
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
  if (platform === "instagram" && content_type === "story" === false) {
    // stories only on IG — FB stories not yet supported
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const meta = createMetaClient();

  // Insert a record so we have an audit trail even for immediate publishes
  const { data: record, error: insertError } = await supabase
    .schema("meta")
    .from("meta_posts")
    .insert({
      platform,
      content_type,
      scheduled_at: new Date().toISOString(),
      status: "processing",
      payload,
      attempt_count: 1,
      last_attempted_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (insertError) {
    console.error("DB insert error:", insertError);
    return json({ error: "Failed to create audit record" }, 500);
  }

  const postId = record.id as string;

  try {
    if (platform === "instagram") {
      const { containerId, mediaId } = await meta.publishInstagram(
        content_type,
        payload as IgPayload,
      );

      await supabase
        .schema("meta")
        .from("meta_posts")
        .update({
          status: "published",
          ig_container_id: containerId,
          ig_media_id: mediaId,
          graph_response: { containerId, mediaId },
        })
        .eq("id", postId);

      return json({
        success: true,
        platform,
        content_type,
        record_id: postId,
        containerId,
        mediaId,
      });
    }

    // Facebook
    const result = await meta.publishFacebook(
      content_type,
      payload as FbPayload,
    );

    await supabase
      .schema("meta")
      .from("meta_posts")
      .update({
        status: "published",
        fb_post_id: result.postId,
        graph_response: result,
      })
      .eq("id", postId);

    return json({
      success: true,
      platform,
      content_type,
      record_id: postId,
      postId: result.postId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Publish error:", message);

    await supabase
      .schema("meta")
      .from("meta_posts")
      .update({
        status: "failed",
        last_error: message,
      })
      .eq("id", postId);

    return json({ error: message }, 500);
  }
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
