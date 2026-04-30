/**
 * /qr-missing — public, NO auth.
 *
 * The /q/[slug] redirect endpoint sends scanners here when:
 *   - the slug doesn't exist
 *   - the code has been archived
 *   - the code has expired
 *
 * Anyone with a phone camera can land on this page. It MUST work for
 * fully-anonymous visitors with no Instinct session — that's why this
 * page lives outside the (dashboard) auth wrapper.
 */

import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "QR not active — Wolfpack Instinct",
  description: "This QR code is no longer active.",
  robots: { index: false, follow: false },
};

export default function QrMissingPage() {
  return (
    <div
      data-testid="qr-missing-page"
      style={{
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "2rem",
        background: "var(--wp-dark, #0b0b10)",
        color: "var(--wp-text, #f4f4f5)",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      <div
        style={{
          maxWidth: "32rem",
          width: "100%",
          background: "var(--wp-dark-surface, #16161d)",
          border: "1px solid var(--wp-dark-border, #2a2a35)",
          borderRadius: "12px",
          padding: "2rem",
          textAlign: "center",
        }}
      >
        <div
          aria-hidden="true"
          style={{
            fontSize: "3rem",
            marginBottom: "0.75rem",
            color: "var(--wp-gold, #d4a857)",
          }}
        >
          {/* Inline QR-ish glyph (SVG). No image asset needed. */}
          <svg
            width="56"
            height="56"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            style={{ margin: "0 auto", display: "block" }}
          >
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
            <path d="M14 14h3v3M20 14v3M14 20h3M20 20h0" />
          </svg>
        </div>
        <h1
          style={{
            fontSize: "1.5rem",
            fontWeight: 700,
            marginBottom: "0.75rem",
            color: "var(--wp-gold, #d4a857)",
          }}
        >
          This QR code is no longer active
        </h1>
        <p
          style={{
            fontSize: "1rem",
            lineHeight: 1.6,
            color: "var(--wp-text-dim, #a1a1aa)",
            marginBottom: "1.5rem",
          }}
        >
          The code you scanned may have expired or been retired. If you
          believe this is a mistake, please contact the team and let them
          know where you scanned it.
        </p>
        <a
          data-testid="qr-missing-support-link"
          href="/support"
          style={{
            display: "inline-block",
            padding: "0.6rem 1.2rem",
            borderRadius: "8px",
            background: "var(--wp-gold, #d4a857)",
            color: "#000",
            fontWeight: 600,
            textDecoration: "none",
          }}
        >
          Contact support
        </a>
        <div
          style={{
            marginTop: "1.5rem",
            fontSize: "0.75rem",
            color: "var(--wp-text-muted, #71717a)",
          }}
        >
          Wolfpack Instinct
        </div>
      </div>
    </div>
  );
}
