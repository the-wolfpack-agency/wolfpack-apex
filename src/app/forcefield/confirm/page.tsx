"use client";

/**
 * /forcefield/confirm?token=... - the double opt-in link from the confirmation
 * email. One click confirms the address (POST /api/forcefield/alert-email/confirm);
 * nothing happens on page load. PUBLIC, no session: the signed token is the
 * credential.
 */
import { TokenActionPage, type TokenActionCopy } from "@/components/forcefield/TokenActionPage";

const COPY: TokenActionCopy = {
  title: "Confirm Forcefield alerts",
  intro: "Click below to confirm this address. Forcefield will then email you when it first sees your site's traffic, when it catches a hostile agent, and once a day with a summary.",
  button: "Confirm alerts",
  busy: "Confirming...",
  done: (site) => `Confirmed. Alerts for ${site} will come to this address. The first one arrives when Forcefield sees your site's traffic.`,
  errors: {
    expired: "This link has expired. Open your dashboard and resend the confirmation email.",
    invalid: "This link is not valid. Use the most recent confirmation email, or resend it from your dashboard.",
    not_found: "This address is no longer set for alerts. Set it again from your dashboard.",
    already_confirmed: "This address is already confirmed. Nothing more to do.",
  },
  fallbackError: "Could not confirm just now. Please try again in a moment.",
};

export default function ForcefieldConfirmPage() {
  return <TokenActionPage endpoint="/api/forcefield/alert-email/confirm" copy={COPY} testPrefix="ff-confirm" />;
}
