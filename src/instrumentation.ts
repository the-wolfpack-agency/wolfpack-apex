/**
 * Server + edge error reporting.
 *
 * WHY THIS EXISTS
 *
 * Instinct had no runtime error reporting of any kind. It has 100 e2e specs and
 * a full verify gate, and none of that tells you what a real person hit in
 * production five minutes ago. wolfpack-auto is the only product that had this,
 * and it is the only one where a bug was found by monitoring rather than by a
 * client reporting it.
 *
 * INERT WITHOUT A DSN
 *
 * `enabled` is gated on the DSN being set, so local dev and any environment
 * without NEXT_PUBLIC_SENTRY_DSN behaves exactly as before. Nothing is sent and
 * nothing is initialized beyond the no-op client.
 *
 * Mirrors wolfpack-auto's setup deliberately — same sample rates, same env
 * gating — so the two products behave the same way and there is one pattern to
 * reason about rather than two.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
      tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
      environment: process.env.NODE_ENV,
    });
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    const Sentry = await import("@sentry/nextjs");
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
      tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
      environment: process.env.NODE_ENV,
    });
  }
}
