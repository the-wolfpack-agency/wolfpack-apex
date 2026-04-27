/**
 * support / seed-patterns — the 5 starter patterns the support library
 * ships with. The migration writes these into Postgres directly; this
 * module is the SOURCE OF TRUTH for tests and for seeding a fresh DB
 * via repo helpers.
 *
 * Keep in lockstep with migration 100_support.sql. The shape mirrors
 * the columns of instinct_support_patterns minus the auto-managed
 * fields (id, success/fail counts, timestamps).
 */

import type { MatchSignature } from "./types";

export interface SeedPattern {
  slug: string;
  name: string;
  category: string;
  match_signatures: MatchSignature[];
  draft_template: string;
}

export const SEED_PATTERNS: ReadonlyArray<SeedPattern> = [
  {
    slug: "aadsts20012-ws-fed",
    name: "Microsoft 365 sign-in fails with AADSTS20012 (WS-Federation)",
    category: "auth",
    match_signatures: [
      { type: "regex", pattern: "AADSTS20012", flags: "i" },
      { type: "regex", pattern: "WS-Federation message", flags: "i" },
    ],
    draft_template: [
      "Hi {{first_name}},",
      "",
      "Thanks for reaching out. The AADSTS20012 / WS-Federation error usually points to a federated-identity hand-off that did not complete cleanly. Please try the steps below in order and let us know which one resolves it.",
      "",
      "1. Open an InPrivate or Incognito browser window and try to sign in. This bypasses any cached tokens that may be stuck.",
      "2. In your Microsoft 365 admin center, confirm the user's sign-in name (UPN) is correct and that the domain is set to Managed (not Federated) for that user.",
      "3. Check that the workstation clock is within 5 minutes of real time. WS-Federation tokens are time-sensitive and skew triggers this exact error.",
      "4. Clear the Windows credential cache for Office: Control Panel > Credential Manager > Windows Credentials, remove any entry that starts with MicrosoftOffice or MSO.",
      "",
      "If you still see the error after step 4, reply to this email with the exact timestamp of the failed attempt and we will pull the sign-in log on our side.",
      "",
      "The Wolfpack Team",
    ].join("\n"),
  },
  {
    slug: "aadsts50126-bad-credentials",
    name: "Microsoft 365 sign-in fails with AADSTS50126 (invalid username or password)",
    category: "auth",
    match_signatures: [
      { type: "regex", pattern: "AADSTS50126", flags: "i" },
    ],
    draft_template: [
      "Hi {{first_name}},",
      "",
      "The AADSTS50126 error means Microsoft rejected the username or password combination at sign-in. The fastest fix is a password reset.",
      "",
      "1. Go to https://passwordreset.microsoftonline.com and follow the recovery flow. You will need access to a registered phone number or recovery email.",
      "2. If recovery options are not set up, reply to this email and we will trigger an admin-side password reset for you.",
      "3. Once you have a new password, sign in at https://portal.office.com to confirm it works before you try Outlook or Teams.",
      "",
      "The Wolfpack Team",
    ].join("\n"),
  },
  {
    slug: "aadsts50034-account-not-found",
    name: "Microsoft 365 sign-in fails with AADSTS50034 (account does not exist)",
    category: "auth",
    match_signatures: [
      { type: "regex", pattern: "AADSTS50034", flags: "i" },
    ],
    draft_template: [
      "Hi {{first_name}},",
      "",
      "The AADSTS50034 error means the username you entered does not exist in the directory you are signing in to. Two things to check:",
      "",
      "1. Confirm the spelling of the email address. A common slip is signing in with a personal address (yourname@gmail.com) instead of the work address (yourname@thewolfpack.agency).",
      "2. Make sure you are signing in to the correct tenant. If you have multiple Microsoft accounts, sign out of all of them at https://login.microsoftonline.com first, then sign back in with only the work account.",
      "",
      "If both of those check out, reply with the exact email address you are using and we will verify it on the directory side.",
      "",
      "The Wolfpack Team",
    ].join("\n"),
  },
  {
    slug: "outlook-license-missing",
    name: "Outlook reports the account does not have a license",
    category: "licensing",
    match_signatures: [
      { type: "regex", pattern: "your account doesn't have a license", flags: "i" },
      { type: "regex", pattern: "Mail Plan", flags: "i" },
    ],
    draft_template: [
      "Hi {{first_name}},",
      "",
      "It looks like your Microsoft 365 mailbox is missing an Exchange Online license. Once we assign one, your Outlook will start working within a few minutes.",
      "",
      "We will assign the license on our side now. After we confirm assignment, please:",
      "",
      "1. Fully close Outlook (File > Exit).",
      "2. Reopen Outlook.",
      "3. If prompted to sign in, use your work email and password.",
      "",
      "If mail still does not load 10 minutes after the license is assigned, reply to this email and we will check the mailbox provisioning status.",
      "",
      "The Wolfpack Team",
    ].join("\n"),
  },
  {
    slug: "mfa-locked-out",
    name: "User cannot sign in because of MFA / Authenticator lockout",
    category: "auth",
    match_signatures: [
      { type: "regex", pattern: "can't sign in.*authenticator", flags: "i" },
      { type: "regex", pattern: "MFA.*lockout", flags: "i" },
    ],
    draft_template: [
      "Hi {{first_name}},",
      "",
      "It sounds like your multi-factor authentication method is no longer reachable (lost phone, reinstalled the Authenticator app, etc.). We can reset the registered methods from the admin side.",
      "",
      "Here is what we will do:",
      "",
      "1. We reset your MFA methods now. This invalidates the old Authenticator pairing and any stored phone numbers.",
      "2. The next time you sign in to https://portal.office.com you will be prompted to set up MFA from scratch. Have your phone with the new Authenticator app ready.",
      "3. After you finish the new setup, sign out and sign back in once to confirm it sticks.",
      "",
      "Reply to this email when you are ready and we will trigger the reset.",
      "",
      "The Wolfpack Team",
    ].join("\n"),
  },
];
