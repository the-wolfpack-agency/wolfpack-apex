"use client";

/**
 * /forcefield/unsubscribe?token=... - the one unsubscribe link in every
 * Forcefield email. One click stops all Forcefield email to this address
 * (POST /api/forcefield/alert-email/unsubscribe); nothing happens on page load.
 * PUBLIC, no session: the signed token is the credential.
 */
import { TokenActionPage, type TokenActionCopy } from "@/components/forcefield/TokenActionPage";

const COPY: TokenActionCopy = {
  title: "Unsubscribe from Forcefield email",
  intro: "Click below to stop all Forcefield alerts and summaries to this address. Protection keeps running; you can turn email back on from your dashboard.",
  button: "Unsubscribe",
  busy: "Unsubscribing...",
  done: (site) => `Unsubscribed. Forcefield will not email this address about ${site} again. Protection keeps running.`,
  errors: {
    expired: "This link has expired. Manage alerts from your dashboard instead.",
    invalid: "This link is not valid. Manage alerts from your dashboard instead.",
    not_found: "This address is no longer receiving Forcefield email.",
  },
  fallbackError: "Could not unsubscribe just now. Please try again in a moment.",
};

export default function ForcefieldUnsubscribePage() {
  return <TokenActionPage endpoint="/api/forcefield/alert-email/unsubscribe" copy={COPY} testPrefix="ff-unsub" />;
}
