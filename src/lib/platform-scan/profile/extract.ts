/**
 * Pure, deterministic extractors that turn raw repo signals (file paths,
 * migration SQL, package.json) into the structured SystemProfile pieces. No I/O,
 * no tokens: every function is a pure transform, so each is exhaustively testable
 * in isolation and the profile is reproducible.
 */
import type { SurfaceCounts, DetectedIntegration } from "./types";

/** npm package -> integration identity. Ordered: first match wins. Patterns are
 *  tested against the dependency NAME. Covers the common SaaS / infra SDKs a
 *  client app talks to; unknown packages are simply not integrations. */
const INTEGRATION_REGISTRY: ReadonlyArray<{ pattern: RegExp; name: string; category: string }> = [
  { pattern: /^@?stripe(\/|$)/, name: "Stripe", category: "Payments" },
  { pattern: /^plaid$/, name: "Plaid", category: "Fintech" },
  { pattern: /quickbooks|node-quickbooks|intuit/, name: "QuickBooks", category: "Accounting" },
  { pattern: /^twilio$/, name: "Twilio", category: "SMS/Voice" },
  { pattern: /^@sendgrid\//, name: "SendGrid", category: "Email" },
  { pattern: /^(nodemailer|resend|postmark|mailgun.*)$/, name: "Email provider", category: "Email" },
  { pattern: /^@?aws-sdk(\/|$)|^aws-sdk$/, name: "AWS", category: "Cloud" },
  { pattern: /^@azure\//, name: "Azure", category: "Cloud" },
  { pattern: /^@google-cloud\/|^googleapis$/, name: "Google Cloud", category: "Cloud" },
  { pattern: /^firebase(-admin)?$/, name: "Firebase", category: "Cloud" },
  { pattern: /^@supabase\//, name: "Supabase", category: "Backend" },
  { pattern: /^(pg|postgres)$|^@neondatabase\/|^@planetscale\//, name: "Postgres/SQL", category: "Datastore" },
  { pattern: /^(mongodb|mongoose)$/, name: "MongoDB", category: "Datastore" },
  { pattern: /^mysql2?$/, name: "MySQL", category: "Datastore" },
  { pattern: /^(redis|ioredis)$/, name: "Redis", category: "Datastore" },
  { pattern: /^@elastic\/|^elasticsearch$/, name: "Elasticsearch", category: "Search" },
  { pattern: /^algoliasearch$/, name: "Algolia", category: "Search" },
  { pattern: /^@qdrant\//, name: "Qdrant", category: "Vector DB" },
  { pattern: /^neo4j-driver$/, name: "Neo4j", category: "Graph DB" },
  { pattern: /^snowflake-sdk$/, name: "Snowflake", category: "Data Warehouse" },
  { pattern: /^(jsonwebtoken|next-auth|@auth\/|passport.*|@clerk\/)/, name: "Auth", category: "Identity" },
  { pattern: /^(jsforce|@salesforce\/)/, name: "Salesforce", category: "CRM" },
  { pattern: /^@hubspot\//, name: "HubSpot", category: "CRM" },
  { pattern: /^@shopify\/|^shopify-api/, name: "Shopify", category: "Commerce" },
  { pattern: /^openai$/, name: "OpenAI", category: "AI" },
  { pattern: /^@anthropic-ai\//, name: "Anthropic", category: "AI" },
  { pattern: /^@slack\//, name: "Slack", category: "Messaging" },
  { pattern: /^@sentry\//, name: "Sentry", category: "Monitoring" },
];

/** Classify a repo's file paths into a surface-area summary. */
export function classifySurface(paths: string[]): SurfaceCounts {
  const c: SurfaceCounts = { pages: 0, apiRoutes: 0, components: 0, libModules: 0, migrations: 0, tests: 0, totalFiles: paths.length };
  for (const p of paths) {
    const isTest = /__tests__\/|\.(test|spec)\.[tj]sx?$/.test(p);
    if (isTest) { c.tests++; continue; }
    if (/\/api\/.*route\.[tj]sx?$/.test(p)) c.apiRoutes++;
    else if (/(^|\/)page\.[tj]sx?$/.test(p)) c.pages++;
    if (/(^|\/)components?\//.test(p)) c.components++;
    if (/(^|\/)lib\/[^/]+\.[tj]sx?$/.test(p)) c.libModules++;
    if (/migrations?\/.*\.sql$/.test(p)) c.migrations++;
  }
  return c;
}

/** Pull DB table names from migration SQL (the data model). Deduped, sorted. */
export function extractEntities(migrationContents: string[]): string[] {
  const tables = new Set<string>();
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?["'`]?([a-z][a-z0-9_]*)["'`]?/gi;
  for (const content of migrationContents) {
    if (!content) continue;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) tables.add(m[1].toLowerCase());
  }
  return Array.from(tables).sort();
}

/** Map a package.json's dependencies to known external integrations. */
export function extractIntegrations(packageJsonRaw: string | null): DetectedIntegration[] {
  if (!packageJsonRaw) return [];
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(packageJsonRaw);
  } catch {
    return [];
  }
  // Runtime dependencies reveal real integrations; devDependencies are tooling.
  const deps = Object.keys(pkg.dependencies ?? {});
  const seen = new Set<string>();
  const out: DetectedIntegration[] = [];
  for (const dep of deps) {
    for (const entry of INTEGRATION_REGISTRY) {
      if (!entry.pattern.test(dep)) continue;
      if (seen.has(entry.name)) break; // one entry per integration name
      seen.add(entry.name);
      out.push({ name: entry.name, package: dep, category: entry.category });
      break;
    }
  }
  return out;
}

/** Count public vs auth-required routes from the manifest specs. */
export function classifyAuth(routes: ReadonlyArray<{ auth?: string }>): { publicRoutes: number; protectedRoutes: number } {
  let publicRoutes = 0;
  let protectedRoutes = 0;
  for (const r of routes) {
    if (r.auth === "required") protectedRoutes++;
    else publicRoutes++;
  }
  return { publicRoutes, protectedRoutes };
}
