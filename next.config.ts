import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import path from "node:path";

const nextConfig: NextConfig = {
  // Pin the workspace root to THIS repo so Vercel's file tracing
  // includes node_modules from /var/task/wolfpack-apex/node_modules
  // instead of guessing from a parent lockfile (which silently drops
  // server-only packages like unpdf from the function bundle).
  outputFileTracingRoot: path.resolve(__dirname),
  // unpdf wraps pdfjs-dist's legacy build which uses dynamic require
  // for its worker. @react-pdf/renderer is ESM-only and pulls in
  // yoga-layout WASM via its own ESM tree — both fail when Webpack
  // bundles them. Mark as external so Next loads them at request
  // time via Node's native loader.
  serverExternalPackages: ["unpdf", "@react-pdf/renderer"],
};

/* Source-map upload only when a token is present.
 *
 * Wrapping unconditionally makes every build — local, CI, a contributor's
 * machine — depend on Sentry credentials it has no reason to hold, and a build
 * that fails on a missing telemetry secret is a worse outcome than unreadable
 * stack traces. With the token set (Vercel production), maps upload and traces
 * resolve to real file names instead of minified chunk offsets.
 *
 * Mirrors wolfpack-auto's config so both products behave identically. */
export default process.env.SENTRY_AUTH_TOKEN
  ? withSentryConfig(nextConfig, {
      silent: true,
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
    })
  : nextConfig;
