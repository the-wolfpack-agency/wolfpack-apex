-- Learned hostile-tradecraft signatures: the collect -> learn -> detect-faster loop.
-- We mine recurring tradecraft tell-combinations from operators we have ALREADY
-- caught (hostile dossiers), persist each combo as a signature, and match new
-- operators against them so a brand-new agent that behaves like prior hostiles is
-- caught by its methods - before it trips a honeytoken.
--
-- Enforcement is EARNED, not assumed (best practice: shadow, then enforce). A
-- signature starts 'shadow' (records would-block only). It auto-promotes to
-- 'enforcing' (auto-block via the existing distributed block list) ONLY once it
-- has been exhibited by enough distinct caught hostiles, is built from
-- dangerous-tier tradecraft, and has logged ZERO false positives against
-- welcomed/known-good agents. Reversible: an admin can retire a signature.
CREATE TABLE IF NOT EXISTS instinct_learned_hostile_signatures (
  sig_hash             TEXT PRIMARY KEY,
  workspace_id         TEXT        NOT NULL DEFAULT 'default',
  tells                TEXT[]      NOT NULL,
  dangerous            BOOLEAN     NOT NULL DEFAULT false,
  prevalence           INTEGER     NOT NULL DEFAULT 0,   -- distinct caught hostiles exhibiting this combo
  status               TEXT        NOT NULL DEFAULT 'shadow' CHECK (status IN ('shadow','enforcing','retired')),
  shadow_matches       INTEGER     NOT NULL DEFAULT 0,   -- live hostile/elevated operators matched while shadow
  false_positive_hits  INTEGER     NOT NULL DEFAULT 0,   -- welcomed/known-good operators matched (blocks promotion)
  auto_blocked         INTEGER     NOT NULL DEFAULT 0,   -- operators auto-blocked once enforcing
  first_seen           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_evaluated       TIMESTAMPTZ,
  promoted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_learned_sig_status ON instinct_learned_hostile_signatures (workspace_id, status);
