"use client";

/**
 * Last-resort boundary for a render error that escapes every page boundary.
 *
 * Next.js only reports these through a global-error boundary; without one the
 * user sees a blank white page and nothing is captured, which is the exact
 * failure mode this product has hit before under a different cause.
 *
 * Styled to Instinct's dark theme with literal values rather than the
 * `var(--wp-*)` tokens the rest of the app uses. This component renders its own
 * <html>/<body>, which means the app's stylesheet may not have loaded — a
 * token here would resolve to nothing and produce unreadable text at the exact
 * moment somebody most needs to read it.
 */
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0b0b0d" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            fontFamily: "system-ui, sans-serif",
            padding: 16,
            textAlign: "center",
            color: "#e8e8ea",
          }}
        >
          <h1 style={{ marginBottom: 8, fontSize: 22 }}>Something went wrong</h1>
          <p style={{ color: "#9a9aa2", marginBottom: 24, maxWidth: 420 }}>
            The page could not be displayed. The team has been notified.
          </p>
          <button
            onClick={reset}
            style={{
              padding: "10px 24px",
              background: "#e8b923",
              color: "#0b0b0d",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
              fontSize: 15,
              fontWeight: 600,
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
