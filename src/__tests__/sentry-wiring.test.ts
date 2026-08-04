/**
 * Sentry is wired, and inert without a DSN.
 *
 * Instinct had no runtime error reporting at all. These pin the two properties
 * that make adding it safe rather than a new failure mode of its own:
 *
 *   1. Nothing is sent when no DSN is configured, so local dev, CI and any
 *      un-provisioned environment behave exactly as before.
 *   2. The pieces Next.js actually requires are present. A global-error
 *      boundary is the only way a render error that escapes every page
 *      boundary gets reported; without it the user sees a white page and
 *      nothing is captured.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("Sentry wiring", () => {
  test.each([
    "src/instrumentation.ts",
    "src/instrumentation-client.ts",
    "src/app/global-error.tsx",
  ])("%s exists", (p) => {
    expect(existsSync(join(ROOT, p))).toBe(true);
  });

  test.each(["src/instrumentation.ts", "src/instrumentation-client.ts"])(
    "%s is disabled without a DSN",
    (p) => {
      /* Sentry.init with an undefined dsn is already a no-op, but `enabled`
         makes the intent explicit and survives a future SDK that changes that
         default. */
      expect(read(p)).toContain("enabled: !!process.env.NEXT_PUBLIC_SENTRY_DSN");
    },
  );

  test("the global-error boundary actually reports", () => {
    /* A boundary that renders a nice message and captures nothing is worse
       than no boundary: it looks handled. */
    expect(read("src/app/global-error.tsx")).toContain("Sentry.captureException(error)");
  });

  test("source-map upload is gated on the auth token", () => {
    /* Wrapping unconditionally makes every build depend on a Sentry secret it
       has no reason to hold, and a build that fails on a missing telemetry
       credential is worse than unreadable stack traces. */
    expect(read("next.config.ts")).toContain("process.env.SENTRY_AUTH_TOKEN");
  });

  test("session replay is error-only, never continuously sampled", () => {
    /* Instinct shows mail, calendars, HR documents and client financials.
       Recording sessions at random would put that in a third-party service for
       no diagnostic benefit. */
    const src = read("src/instrumentation-client.ts");
    expect(src).toContain("replaysSessionSampleRate: 0");
    expect(src).toContain("replaysOnErrorSampleRate");
  });

  test("the CSP still allows the ingest host", () => {
    /* Telemetry a CSP blocks is worse than none: it looks like everything is
       fine. connect-src must not be narrowed to 'self' without adding Sentry
       explicitly. */
    const csp = read("src/middleware.ts");
    const connect = /connect-src ([^"]+)"/.exec(csp)?.[1] ?? "";
    expect(connect.includes("https:") || connect.includes("sentry.io")).toBe(true);
  });
});
