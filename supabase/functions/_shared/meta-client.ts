/**
 * Meta Graph API v22.0 client for Viorette Instagram + Facebook publishing.
 *
 * Flow for all Instagram content:
 *   1. createIgContainer()   → container_id
 *   2. pollContainerStatus() → wait until status === "FINISHED"
 *   3. publishIgContainer()  → media_id
 *
 * Facebook posts support native scheduled_publish_time via Graph API,
 * so no DB queue is needed for FB scheduling.
 */

const BASE = "https://graph.facebook.com/v22.0";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Platform = "instagram" | "facebook";
export type ContentType = "post" | "carousel" | "story";

export interface IgPostPayload {
  caption: string;
  image_url: string;
}

export interface IgCarouselChild {
  image_url: string;
}

export interface IgCarouselPayload {
  caption: string;
  children: IgCarouselChild[];
}

export interface IgStoryPayload {
  image_url?: string;
  video_url?: string;
}

export type IgPayload = IgPostPayload | IgCarouselPayload | IgStoryPayload;

export interface FbPostPayload {
  message: string;
  link?: string;
  image_url?: string;
  /** Unix timestamp. Present only for scheduled Facebook posts. */
  scheduled_publish_time?: number;
}

export interface FbCarouselChild {
  image_url: string;
  name?: string;
  description?: string;
  link?: string;
}

export interface FbCarouselPayload {
  message: string;
  children: FbCarouselChild[];
  scheduled_publish_time?: number;
}

export type FbPayload = FbPostPayload | FbCarouselPayload;

export interface MetaClientConfig {
  accessToken: string;
  igAccountId: string;
  fbPageId: string;
}

export interface IgContainerResult {
  containerId: string;
}

export interface IgPublishResult {
  mediaId: string;
}

export interface FbPublishResult {
  postId: string;
}

export type ContainerStatus =
  | "IN_PROGRESS"
  | "FINISHED"
  | "PUBLISHED"
  | "ERROR"
  | "EXPIRED";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function graphPost(
  path: string,
  params: Record<string, string>,
  token: string,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || json.error) {
    const err = (json.error as Record<string, unknown>) ?? json;
    throw new Error(
      `Graph API error [${path}]: ${err.message ?? JSON.stringify(err)}`,
    );
  }
  return json;
}

async function graphGet(
  path: string,
  params: Record<string, string>,
  token: string,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(`${BASE}/${path}?${qs}`);
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok || json.error) {
    const err = (json.error as Record<string, unknown>) ?? json;
    throw new Error(
      `Graph API error [GET ${path}]: ${err.message ?? JSON.stringify(err)}`,
    );
  }
  return json;
}

// ─── MetaClient ───────────────────────────────────────────────────────────────

export class MetaClient {
  private token: string;
  private igId: string;
  private fbId: string;

  constructor(cfg: MetaClientConfig) {
    this.token = cfg.accessToken;
    this.igId = cfg.igAccountId;
    this.fbId = cfg.fbPageId;
  }

  // ── Instagram ──────────────────────────────────────────────────────────────

  /** Step 1a: single-image container (post or story). */
  async createIgImageContainer(
    payload: IgPostPayload | IgStoryPayload,
    isStory = false,
  ): Promise<IgContainerResult> {
    const params: Record<string, string> = {
      media_type: isStory ? "STORIES" : "IMAGE",
    };
    if ("image_url" in payload && payload.image_url) {
      params.image_url = payload.image_url;
    }
    if ("video_url" in payload && payload.video_url) {
      params.media_type = "VIDEO";
      params.video_url = payload.video_url;
    }
    if ("caption" in payload && payload.caption) {
      params.caption = payload.caption;
    }

    const data = await graphPost(
      `${this.igId}/media`,
      params,
      this.token,
    );
    return { containerId: data.id as string };
  }

  /** Step 1b: carousel – create child containers, then the carousel container. */
  async createIgCarouselContainer(
    payload: IgCarouselPayload,
  ): Promise<IgContainerResult> {
    // Create one container per child image
    const childIds: string[] = [];
    for (const child of payload.children) {
      const data = await graphPost(
        `${this.igId}/media`,
        { image_url: child.image_url, is_carousel_item: "true" },
        this.token,
      );
      childIds.push(data.id as string);
    }

    // Create the carousel container
    const data = await graphPost(
      `${this.igId}/media`,
      {
        media_type: "CAROUSEL",
        caption: payload.caption,
        children: childIds.join(","),
      },
      this.token,
    );
    return { containerId: data.id as string };
  }

  /** Step 2: poll until container status is FINISHED (or ERROR/EXPIRED). */
  async pollContainerStatus(
    containerId: string,
    opts: { maxAttempts?: number; intervalMs?: number } = {},
  ): Promise<ContainerStatus> {
    const maxAttempts = opts.maxAttempts ?? 20;
    const intervalMs = opts.intervalMs ?? 3000;

    for (let i = 0; i < maxAttempts; i++) {
      const data = await graphGet(
        containerId,
        { fields: "status_code" },
        this.token,
      );
      const status = data.status_code as ContainerStatus;

      if (status === "FINISHED") return status;
      if (status === "ERROR" || status === "EXPIRED") {
        throw new Error(`IG container ${containerId} reached status: ${status}`);
      }

      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(
      `IG container ${containerId} did not finish within ${maxAttempts} attempts`,
    );
  }

  /** Step 3: publish a ready container. */
  async publishIgContainer(containerId: string): Promise<IgPublishResult> {
    const data = await graphPost(
      `${this.igId}/media_publish`,
      { creation_id: containerId },
      this.token,
    );
    return { mediaId: data.id as string };
  }

  /**
   * Full IG publish flow: create container → poll → publish.
   * Used by meta-publish (immediate) and meta-process-queue (scheduled).
   */
  async publishInstagram(
    contentType: ContentType,
    payload: IgPayload,
  ): Promise<{ containerId: string; mediaId: string }> {
    let containerId: string;

    if (contentType === "carousel") {
      const res = await this.createIgCarouselContainer(
        payload as IgCarouselPayload,
      );
      containerId = res.containerId;
    } else {
      const res = await this.createIgImageContainer(
        payload as IgPostPayload | IgStoryPayload,
        contentType === "story",
      );
      containerId = res.containerId;
    }

    await this.pollContainerStatus(containerId);
    const { mediaId } = await this.publishIgContainer(containerId);
    return { containerId, mediaId };
  }

  // ── Facebook ───────────────────────────────────────────────────────────────

  /**
   * Publish or schedule a Facebook post.
   * Pass scheduled_publish_time (Unix timestamp) to use FB native scheduling.
   */
  async publishFacebookPost(payload: FbPostPayload): Promise<FbPublishResult> {
    const params: Record<string, string> = {
      message: payload.message,
    };
    if (payload.link) params.link = payload.link;
    if (payload.scheduled_publish_time) {
      params.published = "false";
      params.scheduled_publish_time = String(payload.scheduled_publish_time);
    }

    // If there's an image, use the /photos endpoint instead of /feed
    if (payload.image_url) {
      const data = await graphPost(
        `${this.fbId}/photos`,
        { ...params, url: payload.image_url },
        this.token,
      );
      return { postId: (data.post_id ?? data.id) as string };
    }

    const data = await graphPost(`${this.fbId}/feed`, params, this.token);
    return { postId: data.id as string };
  }

  /**
   * Publish or schedule a Facebook carousel (link-style multi-image post).
   * FB carousels are created as link ad posts; for organic pages the approach
   * is to post the first image with message and attach link previews via the
   * multi-share format using the /feed endpoint with attached_media.
   */
  async publishFacebookCarousel(
    payload: FbCarouselPayload,
  ): Promise<FbPublishResult> {
    // Step 1: upload each image as an unpublished photo to get fbid
    const mediaFbids: string[] = [];
    for (const child of payload.children) {
      const photoData = await graphPost(
        `${this.fbId}/photos`,
        {
          url: child.image_url,
          published: "false",
          ...(child.name ? { name: child.name } : {}),
        },
        this.token,
      );
      mediaFbids.push(photoData.id as string);
    }

    // Step 2: publish the feed post with attached_media
    const attachedMedia = mediaFbids
      .map((fbid) => JSON.stringify({ media_fbid: fbid }))
      .join(",");

    const params: Record<string, string> = {
      message: payload.message,
      attached_media: `[${attachedMedia}]`,
    };
    if (payload.scheduled_publish_time) {
      params.published = "false";
      params.scheduled_publish_time = String(payload.scheduled_publish_time);
    }

    const data = await graphPost(`${this.fbId}/feed`, params, this.token);
    return { postId: data.id as string };
  }

  /** Unified Facebook publish dispatcher. */
  async publishFacebook(
    contentType: ContentType,
    payload: FbPayload,
  ): Promise<FbPublishResult> {
    if (contentType === "carousel") {
      return this.publishFacebookCarousel(payload as FbCarouselPayload);
    }
    return this.publishFacebookPost(payload as FbPostPayload);
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createMetaClient(): MetaClient {
  const accessToken = Deno.env.get("META_ACCESS_TOKEN");
  const igAccountId = Deno.env.get("INSTAGRAM_BUSINESS_ACCOUNT_ID");
  const fbPageId = Deno.env.get("FACEBOOK_PAGE_ID");

  if (!accessToken || !igAccountId || !fbPageId) {
    throw new Error(
      "Missing required env vars: META_ACCESS_TOKEN, INSTAGRAM_BUSINESS_ACCOUNT_ID, FACEBOOK_PAGE_ID",
    );
  }

  return new MetaClient({ accessToken, igAccountId, fbPageId });
}
