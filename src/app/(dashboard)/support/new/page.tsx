"use client";

/**
 * /support/new — dedicated new-ticket page.
 *
 * Hosts <TicketForm /> and handles navigation: on success the user
 * lands on /support/[id] for the freshly created ticket so they can
 * immediately review the AI draft.
 *
 * Auth: redirect unauthenticated users to /login?next=/support/new
 * before any blank state can render.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getInstinctToken } from "@/lib/client-auth";
import TicketForm from "../_components/TicketForm";
import type { SupportTicket } from "../_components/TicketList";

function rerouteToLogin() {
  if (typeof window === "undefined") return;
  const next = encodeURIComponent(window.location.pathname);
  window.location.href = `/login?next=${next}`;
}

export default function SupportNewPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    if (!getInstinctToken()) {
      rerouteToLogin();
      return;
    }
    setAuthChecked(true);
  }, []);

  if (!authChecked) return null;

  function handleCreated(t: SupportTicket) {
    router.push(`/support/${encodeURIComponent(t.id)}`);
  }

  return (
    <main
      data-testid="support-new-page"
      style={{
        padding: "2rem",
        maxWidth: 760,
        margin: "0 auto",
        color: "var(--wp-text)",
      }}
    >
      <Link
        href="/support"
        data-testid="support-new-back"
        style={{
          fontSize: "0.8rem",
          color: "var(--wp-text-dim)",
          textDecoration: "none",
          display: "inline-block",
          padding: "0.5rem 0.4rem",
          margin: "-0.5rem -0.4rem 0.4rem",
          touchAction: "manipulation",
        }}
      >
        ← Back to Support
      </Link>
      <header style={{ marginBottom: "1.4rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.7rem" }}>New support ticket</h1>
        <p
          style={{
            marginTop: "0.4rem",
            color: "var(--wp-text-dim)",
            maxWidth: "60ch",
            lineHeight: 1.45,
          }}
        >
          Tell us what&apos;s happening. We&apos;ll match it against the
          playbooks we already have and draft a response you can edit
          before sending.
        </p>
      </header>

      <TicketForm onCreated={handleCreated} />
    </main>
  );
}
