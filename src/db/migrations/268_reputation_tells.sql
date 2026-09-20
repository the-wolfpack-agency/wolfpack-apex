-- TTP sharing: the reputation network already shares an opaque fingerprint +
-- severity + behavior classes. This adds the finer TRADECRAFT tells (the specific
-- signals an actor gave off: tripped_decoy, payload_attack, id_enumeration, ...),
-- so a consuming workspace recognizes the same actor's methods, not just its
-- fingerprint. Still non-PII: signal names only.
ALTER TABLE instinct_operator_reputation
  ADD COLUMN IF NOT EXISTS tells TEXT[] NOT NULL DEFAULT '{}';
