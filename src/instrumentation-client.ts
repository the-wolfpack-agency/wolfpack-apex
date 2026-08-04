/**
 * Browser error reporting.
 *
 * Instinct's CSP already allows this: `connect-src 'self' https:` in
 * middleware.ts permits the Sentry ingest host, so events are not silently
 * dropped. That was worth checking before adding this at all — telemetry a CSP
 * blocks is worse than none, because it looks like everything is fine.
 *
 * Session replay is captured ONLY on error, never sampled continuously. This is
 * an internal OS showing mail, calendars, HR documents and client financials;
 * recording sessions at random would put that content in a third-party service
 * for no diagnostic benefit. On error it is the difference between a stack
 * trace and knowing what somebody actually did.
 */
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
  environment: process.env.NODE_ENV,
  replaysOnErrorSampleRate: process.env.NODE_ENV === "production" ? 1.0 : 0,
  replaysSessionSampleRate: 0,
});
