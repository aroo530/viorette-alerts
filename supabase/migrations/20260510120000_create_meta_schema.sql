-- Create dedicated schema for Meta (Instagram + Facebook) content publishing
create schema if not exists meta;

-- Grant usage to authenticated and service roles
grant usage on schema meta to authenticated, service_role, anon;
alter default privileges in schema meta
  grant select, insert, update, delete on tables to service_role;

-- ─── meta_posts queue table ───────────────────────────────────────────────────
create type meta.platform as enum ('instagram', 'facebook');
create type meta.content_type as enum ('post', 'carousel', 'story');
create type meta.post_status as enum (
  'pending',       -- waiting to be processed by cron
  'processing',    -- cron picked it up, container being created / polled
  'published',     -- successfully published
  'failed',        -- permanent failure after retries
  'cancelled'      -- manually cancelled before publish time
);

create table meta.meta_posts (
  id                  uuid primary key default gen_random_uuid(),

  -- targeting
  platform            meta.platform     not null,
  content_type        meta.content_type not null,

  -- scheduling
  scheduled_at        timestamptz       not null, -- when to publish (UTC)
  status              meta.post_status  not null default 'pending',

  -- content payload (stored as JSONB so each content type can differ)
  -- instagram post:    { caption, image_url }
  -- instagram carousel: { caption, children: [{ image_url }] }
  -- instagram story:   { image_url | video_url }
  -- facebook post:     { message, link?, image_url? }
  -- facebook carousel: { message, children: [{ image_url, name?, description?, link? }] }
  payload             jsonb             not null,

  -- Graph API response data
  ig_container_id     text,             -- IG container created at process time
  ig_media_id         text,             -- IG media id after publish
  fb_post_id          text,             -- Facebook post id
  graph_response      jsonb,            -- last raw Graph API response

  -- retry / failure tracking
  attempt_count       integer           not null default 0,
  max_attempts        integer           not null default 3,
  last_error          text,
  last_attempted_at   timestamptz,

  -- audit
  created_at          timestamptz       not null default now(),
  updated_at          timestamptz       not null default now()
);

-- Index for the cron worker: grab pending posts whose scheduled_at is due
create index meta_posts_pending_due_idx
  on meta.meta_posts (scheduled_at)
  where status = 'pending';

-- Index for processing state (used when polling containers)
create index meta_posts_processing_idx
  on meta.meta_posts (last_attempted_at)
  where status = 'processing';

-- Auto-update updated_at
create or replace function meta.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger meta_posts_set_updated_at
  before update on meta.meta_posts
  for each row execute function meta.set_updated_at();

-- ─── pg_cron: process queue every minute ─────────────────────────────────────
-- Requires pg_cron extension (already available on Supabase).
-- The Edge Function URL is injected via Supabase Vault / env at function deploy time.
-- We schedule via the Supabase Dashboard cron UI or the SQL below.
-- Uncomment after deploying the meta-process-queue function and setting the secret.

-- select cron.schedule(
--   'meta-process-queue',
--   '* * * * *',
--   $$
--     select net.http_post(
--       url    := current_setting('app.meta_process_queue_url'),
--       body   := '{}'::jsonb,
--       headers := jsonb_build_object(
--         'Authorization', 'Bearer ' || current_setting('app.supabase_service_role_key'),
--         'Content-Type', 'application/json'
--       )
--     );
--   $$
-- );
