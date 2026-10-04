-- Factory brain #7, MEMORY USEFULNESS: mark whether a retrieved reuse suggestion
-- was ACTUALLY USED in the authored change, not merely retrieved. Precise credit
-- assignment - a suggestion the brain surfaced but the author ignored should not
-- be reinforced on merge (it did not help) nor decayed on reject (not its fault).
-- Only reuse entries carry a meaningful `used`; failure entries stay false.
-- Additive + idempotent.
ALTER TABLE instinct_factory_memory_provenance
  ADD COLUMN IF NOT EXISTS used boolean NOT NULL DEFAULT false;
