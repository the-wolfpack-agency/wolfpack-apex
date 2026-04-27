-- 100_support.sql — Support ticket system + pattern library.
--
-- Operator-facing support feature: an operator submits a ticket describing
-- a user issue, the system finds matching patterns from a curated library,
-- generates an AI draft response (Claude), and captures feedback so the
-- pattern library improves over time.
--
-- Two tables:
--   1. instinct_support_tickets   — one row per support request, full
--      lifecycle from open → drafted → sent → resolved/closed. Carries
--      the AI draft + the final sent response + post-send feedback.
--   2. instinct_support_patterns  — knowledge library of recurring issues.
--      Each row holds match signatures (regex/substring) and a markdown
--      response template. success_count / fail_count drive ranking.
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT wraps every statement.
--   * IF NOT EXISTS on tables + indexes — re-runnable.
--   * Final DO block ASSERTs the tables + check constraints exist.
--   * Down migration drops in reverse order with IF EXISTS.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

-- ============================================================
-- instinct_support_tickets
-- ============================================================
CREATE TABLE IF NOT EXISTS instinct_support_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  diagnostic_text TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  severity TEXT NOT NULL DEFAULT 'p2',
  status TEXT NOT NULL DEFAULT 'open',
  created_by_user_id TEXT NOT NULL,
  created_by_email TEXT,
  draft_response TEXT,
  draft_generated_at TIMESTAMPTZ,
  draft_pattern_ids UUID[] DEFAULT ARRAY[]::UUID[],
  sent_response TEXT,
  sent_at TIMESTAMPTZ,
  sent_to_email TEXT,
  helpful BOOLEAN,
  edit_diff JSONB,
  feedback_notes TEXT,
  feedback_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instinct_support_tickets_severity_chk
    CHECK (severity IN ('p0','p1','p2','p3')),
  CONSTRAINT instinct_support_tickets_status_chk
    CHECK (status IN ('open','drafted','sent','resolved','closed'))
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status
  ON instinct_support_tickets(status);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created_by
  ON instinct_support_tickets(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_support_tickets_created_at
  ON instinct_support_tickets(created_at DESC);

-- ============================================================
-- instinct_support_patterns
-- ============================================================
CREATE TABLE IF NOT EXISTS instinct_support_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  match_signatures JSONB NOT NULL,
  draft_template TEXT NOT NULL,
  success_count INT NOT NULL DEFAULT 0,
  fail_count INT NOT NULL DEFAULT 0,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_patterns_enabled
  ON instinct_support_patterns(enabled);

-- ============================================================
-- Seed the pattern library (5 rows). ON CONFLICT DO NOTHING so
-- re-running the migration after operator edits never clobbers
-- learned counts.
-- ============================================================
INSERT INTO instinct_support_patterns (slug, name, category, match_signatures, draft_template)
VALUES
  (
    'aadsts20012-ws-fed',
    'Microsoft 365 sign-in fails with AADSTS20012 (WS-Federation)',
    'auth',
    '[{"type":"regex","pattern":"AADSTS20012","flags":"i"},{"type":"regex","pattern":"WS-Federation message","flags":"i"}]'::jsonb,
    'Hi {{first_name}},

Thanks for reaching out. The AADSTS20012 / WS-Federation error usually points to a federated-identity hand-off that did not complete cleanly. Please try the steps below in order and let us know which one resolves it.

1. Open an InPrivate or Incognito browser window and try to sign in. This bypasses any cached tokens that may be stuck.
2. In your Microsoft 365 admin center, confirm the user''s sign-in name (UPN) is correct and that the domain is set to Managed (not Federated) for that user.
3. Check that the workstation clock is within 5 minutes of real time. WS-Federation tokens are time-sensitive and skew triggers this exact error.
4. Clear the Windows credential cache for Office: Control Panel > Credential Manager > Windows Credentials, remove any entry that starts with MicrosoftOffice or MSO.

If you still see the error after step 4, reply to this email with the exact timestamp of the failed attempt and we will pull the sign-in log on our side.

The Wolfpack Team'
  ),
  (
    'aadsts50126-bad-credentials',
    'Microsoft 365 sign-in fails with AADSTS50126 (invalid username or password)',
    'auth',
    '[{"type":"regex","pattern":"AADSTS50126","flags":"i"}]'::jsonb,
    'Hi {{first_name}},

The AADSTS50126 error means Microsoft rejected the username or password combination at sign-in. The fastest fix is a password reset.

1. Go to https://passwordreset.microsoftonline.com and follow the recovery flow. You will need access to a registered phone number or recovery email.
2. If recovery options are not set up, reply to this email and we will trigger an admin-side password reset for you.
3. Once you have a new password, sign in at https://portal.office.com to confirm it works before you try Outlook or Teams.

The Wolfpack Team'
  ),
  (
    'aadsts50034-account-not-found',
    'Microsoft 365 sign-in fails with AADSTS50034 (account does not exist)',
    'auth',
    '[{"type":"regex","pattern":"AADSTS50034","flags":"i"}]'::jsonb,
    'Hi {{first_name}},

The AADSTS50034 error means the username you entered does not exist in the directory you are signing in to. Two things to check:

1. Confirm the spelling of the email address. A common slip is signing in with a personal address (yourname@gmail.com) instead of the work address (yourname@thewolfpack.agency).
2. Make sure you are signing in to the correct tenant. If you have multiple Microsoft accounts, sign out of all of them at https://login.microsoftonline.com first, then sign back in with only the work account.

If both of those check out, reply with the exact email address you are using and we will verify it on the directory side.

The Wolfpack Team'
  ),
  (
    'outlook-license-missing',
    'Outlook reports the account does not have a license',
    'licensing',
    '[{"type":"regex","pattern":"your account doesn''t have a license","flags":"i"},{"type":"regex","pattern":"Mail Plan","flags":"i"}]'::jsonb,
    'Hi {{first_name}},

It looks like your Microsoft 365 mailbox is missing an Exchange Online license. Once we assign one, your Outlook will start working within a few minutes.

We will assign the license on our side now. After we confirm assignment, please:

1. Fully close Outlook (File > Exit).
2. Reopen Outlook.
3. If prompted to sign in, use your work email and password.

If mail still does not load 10 minutes after the license is assigned, reply to this email and we will check the mailbox provisioning status.

The Wolfpack Team'
  ),
  (
    'mfa-locked-out',
    'User cannot sign in because of MFA / Authenticator lockout',
    'auth',
    '[{"type":"regex","pattern":"can''t sign in.*authenticator","flags":"i"},{"type":"regex","pattern":"MFA.*lockout","flags":"i"}]'::jsonb,
    'Hi {{first_name}},

It sounds like your multi-factor authentication method is no longer reachable (lost phone, reinstalled the Authenticator app, etc.). We can reset the registered methods from the admin side.

Here is what we will do:

1. We reset your MFA methods now. This invalidates the old Authenticator pairing and any stored phone numbers.
2. The next time you sign in to https://portal.office.com you will be prompted to set up MFA from scratch. Have your phone with the new Authenticator app ready.
3. After you finish the new setup, sign out and sign back in once to confirm it sticks.

Reply to this email when you are ready and we will trigger the reset.

The Wolfpack Team'
  )
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- Row-count + structure assertions (per memory feedback_migration_safety)
-- ============================================================
DO $$
DECLARE
  pattern_count INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_support_tickets'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) THEN
    RAISE EXCEPTION 'instinct_support_tickets not created — aborting migration 100.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_support_patterns'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) THEN
    RAISE EXCEPTION 'instinct_support_patterns not created — aborting migration 100.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'instinct_support_tickets_severity_chk'
  ) THEN
    RAISE EXCEPTION 'severity CHECK constraint missing — aborting migration 100.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'instinct_support_tickets_status_chk'
  ) THEN
    RAISE EXCEPTION 'status CHECK constraint missing — aborting migration 100.';
  END IF;
  SELECT COUNT(*) INTO pattern_count FROM instinct_support_patterns;
  IF pattern_count < 5 THEN
    RAISE EXCEPTION 'instinct_support_patterns expected at least 5 seed rows, got % — aborting migration 100.', pattern_count;
  END IF;
  RAISE NOTICE '100_support: 2 tables + 4 indexes + 5 seed patterns + 2 check constraints created.';
END $$;

COMMIT;
