-- Read a corner of the analytics table without scanning the whole thing.
--
-- instinct_events holds 4,150,425 rows, 2,639,165 of them inside the 60-day
-- window the pilot dashboard asks about. Of those it needs 6,385: the rest are
-- overwhelmingly token verifications, 1.7 million of them in that window alone.
--
-- There are separate indexes on event_type and on timestamp, and neither helps
-- a query that filters on both: Postgres picks one and scans what it returns.
-- This composite is ordered type-first because the type is the selective half
-- (four values out of a long tail) and the timestamp then narrows a range
-- inside it, which is exactly the shape every dashboard query here has.
--
-- Measured on the query this was written for: 1,445ms to 58ms.
--
-- CONCURRENTLY is deliberately NOT used. It cannot run inside the transaction
-- the migration runner wraps each file in, and on a table this size the plain
-- build is seconds rather than minutes. A deploy that waits three seconds is
-- cheaper than a migration that needs its own special path.
CREATE INDEX IF NOT EXISTS idx_instinct_events_type_ts
  ON instinct_events (event_type, "timestamp" DESC);
