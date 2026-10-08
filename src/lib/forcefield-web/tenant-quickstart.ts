/**
 * Self-serve quick-start: everything a newly-onboarded Forcefield tenant needs to
 * go live, built from its token + site. The raw token appears only here (it is
 * stored hashed), so this is returned once at creation and never reconstructable
 * later. The client picks ONE adapter.
 */
import type { ForcefieldTenant } from "./tenants";
import { connectorByKey, DEFAULT_CONNECTOR, type ConnectorKey } from "./connectors";

/** The OGIAM control-plane endpoints a client's adapter points at. Overridable by
 *  env for a different deployment; the defaults are the production endpoints. */
function controlPlane() {
  const base = process.env.FORCEFIELD_PUBLIC_BASE_URL || "https://wolfpack-instinct.vercel.app";
  return {
    ingestUrl: `${base}/api/site-analytics/ingest`,
    rulesetUrl: `${base}/api/forcefield/ruleset`,
    // The central engine endpoint the thin Next shim posts to (and gets a verdict
    // back from). Authorized by the tenant's own token, so no shared secret and no
    // distributed detection code is needed on the client side.
    observeUrl: `${base}/api/forcefield/observe`,
  };
}

/** A self-contained, copy-paste Next.js middleware (src/middleware.ts). No package
 *  to install: it posts each request's SHAPE to the central engine with the site's
 *  token and applies the verdict. Watch-first (only blocks when FORCEFIELD_ENFORCE
 *  is "on") and fail-open (any error serves the request). This is the real working
 *  file a tenant pastes - there is no @ogiam/forcefield npm package. */
const NEXT_MIDDLEWARE_SOURCE = [
  'import { NextResponse, type NextRequest, type NextFetchEvent } from "next/server";',
  "",
  "// Forcefield drop-in shim. Dark until the env below is set, so adding this file",
  "// changes nothing until you configure it. Sends only request SHAPE (no bodies,",
  "// no header values, no PII).",
  "const ENGINE = process.env.FORCEFIELD_INGEST_URL;   // your engine endpoint",
  "const TOKEN = process.env.FORCEFIELD_EDGE_TOKEN;     // your site key",
  'const SITE = process.env.FORCEFIELD_SITE || process.env.VERCEL_GIT_REPO_SLUG || "site";',
  "",
  "export async function middleware(req: NextRequest, ev: NextFetchEvent): Promise<NextResponse> {",
  '  if (process.env.FORCEFIELD_WEB !== "on" || !ENGINE || !TOKEN) return NextResponse.next();',
  "  const u = new URL(req.url);",
  "  const body = JSON.stringify({",
  "    site: SITE,",
  "    path: u.pathname,",
  "    rawUrl: u.pathname + u.search,",
  "    method: req.method,",
  '    userAgent: req.headers.get("user-agent") ?? "",',
  '    country: req.headers.get("x-vercel-ip-country") ?? "",',
  "    headerNames: Array.from(req.headers.keys()),",
  "  });",
  '  const post = () => fetch(ENGINE, { method: "POST", headers: { "content-type": "application/json", "x-edge-token": TOKEN }, body });',
  "  // Watch mode (default): record, never block, never delay the response.",
  '  if (process.env.FORCEFIELD_ENFORCE !== "on") {',
  "    ev.waitUntil(post().then(() => undefined).catch(() => undefined));",
  "    return NextResponse.next();",
  "  }",
  "  // Enforce mode: apply the engine's verdict; fail-open on any error.",
  "  try {",
  "    const res = await post();",
  '    const verdict = (await res.json().catch(() => ({}))) as { action?: string; reasonKind?: string };',
  '    if (verdict.action === "block") {',
  '      return new NextResponse("Forbidden: flagged as a hostile automated action.", {',
  "        status: 403,",
  '        headers: { "content-type": "text/plain; charset=utf-8" },',
  "      });",
  "    }",
  "  } catch { /* fail-open: Forcefield must never take the site down */ }",
  "  return NextResponse.next();",
  "}",
  "",
  'export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"] };',
].join("\n");

/** The tenant's chosen connector door, resolved for the tailored quick-start. The
 *  env blocks below are always built (back-compatible), but `connector.emits` and
 *  `connector.managed` tell the UI which to SHOW, so a Vercel client is not handed
 *  Cloudflare config and a hosted client is told there is nothing to install. */
export interface QuickstartConnector {
  key: ConnectorKey;
  title: string;
  description: string;
  managed: boolean;
  emits: { next: boolean; cloudflare: boolean };
  steps: string[];
}

export interface TenantQuickstart {
  /** The ingest token the client configures (shown once). */
  token: string;
  ingestUrl: string;
  rulesetUrl: string;
  /** The central engine endpoint the Next shim posts to (authorized by the token). */
  observeUrl: string;
  /** The tenant's platform + the tailoring metadata for its setup. */
  platform: ConnectorKey;
  connector: QuickstartConnector;
  /** Copy-paste env for the Cloudflare Worker adapter (any origin). */
  cloudflareEnv: Record<string, string>;
  /** Copy-paste env for the in-app (Next.js) middleware adapter. */
  nextEnv: Record<string, string>;
  /** The complete, self-contained src/middleware.ts to paste (no package install).
   *  Named nextSnippet for back-compat; it now holds the full working file. */
  nextSnippet: string;
}

export function buildTenantQuickstart(tenant: ForcefieldTenant, token: string): TenantQuickstart {
  const { ingestUrl, rulesetUrl, observeUrl } = controlPlane();
  // Resolve the door; a missing/unknown/legacy platform falls back to the generic shim.
  const meta = connectorByKey(tenant.platform ?? DEFAULT_CONNECTOR) ?? connectorByKey(DEFAULT_CONNECTOR)!;
  const base = {
    FORCEFIELD_SITE: tenant.siteLabel,
    FORCEFIELD_WEB: "on",
    // Watch-first: blocking is off until the client deliberately turns it on.
    FORCEFIELD_ENFORCE: "off",
  };
  return {
    token,
    ingestUrl,
    rulesetUrl,
    observeUrl,
    platform: meta.key,
    connector: {
      key: meta.key,
      title: meta.title,
      description: meta.description,
      managed: meta.managed,
      emits: { ...meta.emits },
      steps: [...meta.steps],
    },
    // Cloudflare Worker: runs the engine at the edge, fetches the ruleset, and
    // forwards observations to the ingest endpoint with the site token.
    cloudflareEnv: {
      ...base,
      SITE_ANALYTICS_INGEST_TOKEN: token,
      FORCEFIELD_INGEST_URL: ingestUrl,
      FORCEFIELD_RULESET_URL: rulesetUrl,
      FORCEFIELD_ORIGIN: "https://your-site.example",
    },
    // Next.js: the thin shim posts to the central engine with the site token and
    // applies the verdict. The token authorizes the request; no shared secret.
    nextEnv: {
      ...base,
      FORCEFIELD_INGEST_URL: observeUrl,
      FORCEFIELD_EDGE_TOKEN: token,
    },
    nextSnippet: NEXT_MIDDLEWARE_SOURCE,
  };
}
