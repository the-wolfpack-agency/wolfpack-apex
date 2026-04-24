-- 081_adopt_wolfpack_aidan_mulready.sql
--
-- Adopt the EXISTING external repo the-wolfpack-agency/wolfpack-aidan-mulready
-- into Instinct's /sites registry so the split-screen brief editor + learning
-- loop target it like any home-grown site.
--
-- Completes the Instinct → brief → deploy round-trip proposed on 2026-04-24.
-- Pair with commit 7d5e5e4 on wolfpack-aidan-mulready, which renamed
-- briefs/cftr.json → briefs/aidan-mulready.json to match Instinct's
-- slug convention (brief edits write to briefs/{client_slug}.json).
--
-- Safety posture — same as the 067 rename + 058/059 renames:
--   1. DEFENSIVE DO BLOCK — existence guards on both the canonical table
--      (instinct_site_projects) and the compat view (apex_site_projects),
--      so this migration tolerates every pre-state: fresh DB, pre-067
--      (apex_site_projects is the table), post-067 (instinct_site_projects
--      is the table). Writes target whichever one is actually a table.
--   2. ON CONFLICT (client_slug) DO NOTHING — re-runs are no-ops, never
--      clobber live data (per feedback_migration_safety.md).
--   3. ROW-COUNT ASSERTION — after the INSERT, assert exactly one row with
--      this slug exists (0 would mean the INSERT failed silently, 2+ would
--      mean data corruption). Fails the migration if violated.
--   4. PAIRED DOWN MIGRATION — 081_adopt_wolfpack_aidan_mulready.down.sql
--      DELETEs the row, also guarded.
--
-- Brief JSONB is inlined from wolfpack-aidan-mulready/briefs/aidan-mulready.json
-- at the commit this migration was authored against. Subsequent brief edits
-- flow through PATCH /api/sites/{id} → GitHub push → Vercel redeploy.
-- Inline (rather than external load) keeps the migration self-contained and
-- runnable on any target PG without filesystem dependency.

BEGIN;

DO $$
DECLARE
  target_relname TEXT;
  existing_count BIGINT;
  post_insert_count BIGINT;
  brief_jsonb JSONB;
  target_id TEXT := 'site_aidan_mulready_cftr';
BEGIN
  -- Figure out which physical relation to write to. After migration 067
  -- the canonical table is instinct_site_projects and apex_site_projects
  -- is a compat view. Before 067 it's the other way around. Both kinds
  -- of INSERT are valid (compat views are updatable per 067's R/W
  -- assertion), but writing to the actual table avoids view-rewriter
  -- surprises on managed PG flavors.
  SELECT c.relname INTO target_relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = current_schema()
     AND c.relkind = 'r'
     AND c.relname IN ('instinct_site_projects', 'apex_site_projects')
   ORDER BY CASE c.relname
              WHEN 'instinct_site_projects' THEN 1
              WHEN 'apex_site_projects' THEN 2
            END
   LIMIT 1;

  IF target_relname IS NULL THEN
    RAISE EXCEPTION 'Neither instinct_site_projects nor apex_site_projects exists as a table; run migrations 009/067 first.';
  END IF;

  RAISE NOTICE 'Adopting wolfpack-aidan-mulready into %', target_relname;

  -- Pre-insert count for the target slug (idempotency + diagnostic).
  EXECUTE format(
    'SELECT COUNT(*) FROM %I WHERE client_slug = $1',
    target_relname
  ) USING 'aidan-mulready' INTO existing_count;

  IF existing_count > 0 THEN
    RAISE NOTICE 'aidan-mulready already adopted (% row); migration is a no-op.', existing_count;
    RETURN;
  END IF;

  -- Brief JSONB, dollar-quoted to survive any content quirks cleanly.
  -- Source of truth: wolfpack-aidan-mulready/briefs/aidan-mulready.json @ 7d5e5e4.
  brief_jsonb := $brief$
{
  "$schema": "../docs/brief-schema.json",
  "client": "aidan-mulready",
  "product": {
    "name": "Cleared for Takeoff Racing",
    "tagline": "Irish racing. Nürburgring stage. Season 2025.",
    "domain": "aidanmulready.com",
    "supportEmail": "sponsor@aidanmulready.com"
  },
  "theme": {
    "bgCanvas": "#080808",
    "bgSurface": "#0f0f0f",
    "bgSurfaceMuted": "#141414",
    "textPrimary": "#FFFFFF",
    "textSecondary": "#888888",
    "textMuted": "#666666",
    "textInverse": "#FFFFFF",
    "brandPrimary": "#C8001E",
    "brandDeep": "#8C0015",
    "brandAccent": "#C8001E",
    "fontBody": "\"Helvetica Neue\", Arial, sans-serif",
    "fontUi": "\"Bebas Neue\", \"Helvetica Neue\", sans-serif",
    "fontImportUrl": "https://cdn.jsdelivr.net/npm/@fontsource/bebas-neue@5.0.2/index.css"
  },
  "pages": [
    {
      "route": "/",
      "title": "Aidan Mulready — CFTR",
      "sections": [
        {
          "type": "hero",
          "heading": "AIDAN MULREADY",
          "body": "Ford Z-Tech Champion · NLS Nürburgring · Nürburgring 24 Hours · Breakell Racing BMW M235i · Car #667",
          "backgroundImage": "/cftr/IMG_4182.jpg",
          "height": "90vh",
          "cta": { "label": "Partner With Us", "href": "/contact" }
        },
        {
          "type": "banner",
          "heading": "CHAMPION",
          "body": "Ford Z-Tech Series · First Year in a Race Car · Ireland"
        },
        {
          "type": "text",
          "heading": "The Driver",
          "body": "An Irish racing driver who claimed a championship in his very first season behind the wheel. In year two, Aidan has stepped onto one of the most demanding and iconic stages in all of motorsport — the Nürburgring Nordschleife. Competing in the NLS endurance series and the legendary Nürburgring 24 Hours with Breakell Racing, Aidan carries the Irish tricolor deep into the heart of European motorsport."
        },
        {
          "type": "stats",
          "heading": "By the numbers",
          "items": [
            { "label": "Year-One Champion", "value": 1, "suffix": "st" },
            { "label": "Car Number", "value": 667, "prefix": "#" },
            { "label": "TikTok Views", "value": 380000 },
            { "label": "Male Audience", "value": 87, "suffix": "%" }
          ]
        },
        {
          "type": "stats",
          "heading": "NLS platform reach",
          "items": [
            { "label": "Digital Views", "value": 145, "suffix": "M+" },
            { "label": "Fans On-Site", "value": 280, "suffix": "K" },
            { "label": "Short-Form Views", "value": 93, "suffix": "M+" },
            { "label": "Livestream Views", "value": 7500000 },
            { "label": "Cameras", "value": 60, "suffix": "+" },
            { "label": "Viewing Hours", "value": 299, "suffix": "K" }
          ]
        },
        {
          "type": "gallery",
          "heading": "On track",
          "images": [
            { "src": "/cftr/IMG_4185.jpg", "alt": "BMW M235i #667 rear at sunset" },
            { "src": "/cftr/IMG_4184.jpg", "alt": "BMW #667 exiting pitlane — Breakell Racing" },
            { "src": "/cftr/IMG_4190.jpg", "alt": "Helmet rear — Irish tricolor & shamrock" }
          ]
        },
        {
          "type": "cards",
          "heading": "Audience & reach",
          "items": [
            { "title": "TikTok", "body": "@aidanmulready — 380K views, 263K new viewers, 20K likes, 87% male audience" },
            { "title": "Instagram", "body": "@aidanmulready — 59.5K video views, 28K in last 90 days, actively growing" },
            { "title": "NLS YouTube", "body": "260K+ subscribers · 61M+ lifetime views on the N24H channel" }
          ]
        },
        {
          "type": "cards",
          "heading": "2025 Season",
          "items": [
            { "title": "NLS Endurance", "body": "Nürburgring Langstrecken-Serie — full season with Breakell Racing in the BMW M235i #667." },
            { "title": "Nürburgring 24 Hours", "body": "Flagship event. 280,000+ fans on-site, 24-hour worldwide broadcast.", "accent": true, "badge": "FLAGSHIP EVENT" }
          ]
        },
        {
          "type": "quote",
          "body": "The Nürburgring is the ultimate test. Every lap is a commitment. Every race is a story.",
          "attribution": "Aidan Mulready"
        },
        {
          "type": "callout",
          "body": "LET'S BUILD SOMETHING TOGETHER — Align your brand with an Irish driver competing on the world's most iconic racing circuit. From livery placement and social integration to digital campaigns and event presence, let's create a partnership that genuinely works for you."
        }
      ]
    },
    {
      "route": "/about",
      "title": "About Aidan",
      "sections": [
        {
          "type": "text",
          "heading": "Irish Racing Pride",
          "body": "Aidan Mulready races under Cleared for Takeoff Racing — aviation-meets-motorsport branding rooted in Irish identity. The shamrock, tricolor, and Irish flag are featured prominently on his helmet livery. His social handle @aidanmulready and website aidanmulready.com appear across the helmet band."
        },
        {
          "type": "quote",
          "body": "The Nürburgring is the ultimate test. Every lap is a commitment. Every race is a story.",
          "attribution": "Aidan Mulready"
        }
      ]
    }
  ],
  "contactForm": {
    "fields": ["name", "email", "message"]
  }
}
  $brief$::jsonb;

  -- INSERT. ON CONFLICT DO NOTHING — re-runs are no-ops even if somehow
  -- the pre-check missed an existing row (e.g. concurrent insert).
  EXECUTE format(
    'INSERT INTO %I (
       id,
       client_slug,
       display_name,
       brief,
       github_repo,
       github_repo_url,
       preview_url,
       status,
       last_canary_passed,
       created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (client_slug) DO NOTHING',
    target_relname
  ) USING
      target_id,
      'aidan-mulready',
      'Aidan Mulready — CFTR',
      brief_jsonb,
      'the-wolfpack-agency/wolfpack-aidan-mulready',
      'https://github.com/the-wolfpack-agency/wolfpack-aidan-mulready',
      'https://wolfpack-aidan-mulready.vercel.app',
      'ready',
      TRUE,
      'system';

  -- Post-insert assertion — exactly one row must exist for this slug.
  -- Zero rows = INSERT silently dropped (view rewriter, RLS, etc.).
  -- Two+ rows = data corruption — the UNIQUE constraint should have
  -- prevented this, so bail loudly.
  EXECUTE format(
    'SELECT COUNT(*) FROM %I WHERE client_slug = $1',
    target_relname
  ) USING 'aidan-mulready' INTO post_insert_count;

  IF post_insert_count != 1 THEN
    RAISE EXCEPTION 'Adoption post-insert count expected 1, got %; aborting.', post_insert_count;
  END IF;

  RAISE NOTICE 'Adopted wolfpack-aidan-mulready as % in % (1 row).', target_id, target_relname;
END $$;

COMMIT;
