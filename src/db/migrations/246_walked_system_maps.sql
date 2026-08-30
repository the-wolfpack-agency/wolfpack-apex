-- Maps of systems learned by WALKING them, which is a different thing from
-- instinct_system_profiles.
--
-- A SystemProfile is built by reading a target's repository: file counts,
-- migration names, package dependencies. That is the right model when the
-- system is ours. It is unavailable when the system is a third-party product
-- the client happens to run, which is most of what a client actually depends
-- on, and is exactly why the walker exists.
--
-- These are kept in their own table rather than coerced into a profile row
-- because the two know genuinely different things. A walk cannot see
-- migrations or tests, and writing zero in those columns would say "this
-- system has no tests" when the truth is "we looked from outside and could not
-- tell". That collapse between absence and zero is the defect class this
-- product has spent its life learning to keep apart, and reusing the table
-- would have reintroduced it in the report a client reads.
--
-- One row per (workspace, entry point): re-walking replaces the snapshot.
CREATE TABLE IF NOT EXISTS instinct_walked_system_maps (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   TEXT NOT NULL,
  platform       TEXT NOT NULL,
  entry_url      TEXT NOT NULL,
  map            JSONB NOT NULL,
  -- Denormalised for listing without parsing the document.
  surface_count  INTEGER NOT NULL DEFAULT 0,
  entity_count   INTEGER NOT NULL DEFAULT 0,
  form_count     INTEGER NOT NULL DEFAULT 0,
  -- NON-ZERO MEANS THE MAP IS INCOMPLETE, and every claim drawn from it
  -- inherits that. Denormalised so a reader cannot miss it.
  frontier_remaining INTEGER NOT NULL DEFAULT 0,
  stop_reason    TEXT,
  -- Who authorised walking somebody else's system. Not optional: this is the
  -- record that the scan was permitted, and it is worth more than the map.
  authorised_by  TEXT NOT NULL,
  generated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS instinct_walked_system_maps_target
  ON instinct_walked_system_maps (workspace_id, entry_url);

CREATE INDEX IF NOT EXISTS instinct_walked_system_maps_workspace
  ON instinct_walked_system_maps (workspace_id, generated_at DESC);
