/**
 * Deployment readiness gate - prove a new client deployment is configured and
 * its backing services are reachable BEFORE it goes live, so it never
 * crash-loops or silently half-works from a missing env var or an unreachable
 * store. This codifies the manual "did we set every Vercel blocker, and can the
 * app actually talk to Postgres / Qdrant / Neo4j / GitHub?" check that we kept
 * running by hand during onboarding. It is the seamless-onboarding enabler.
 *
 * DESIGN - why BOTH env-presence AND live-connectivity checks?
 *
 *   1. Env-presence ALONE is necessary but not sufficient. `DATABASE_URL` can be
 *      set yet point at a paused Neon branch; `QDRANT_API_KEY` can be present but
 *      rotated; `GITHUB_TOKEN_WOLFPACK_AGENCY` can be set but expired. The var is
 *      "there" and the app still half-works in prod. Env-present, service-down is
 *      the failure that actually bites a client launch.
 *   2. Live-connectivity ALONE can't distinguish "not configured yet" (the var is
 *      simply absent - the operator forgot to paste it) from "configured but the
 *      service is down." The first is an onboarding step; the second is an outage.
 *      Reporting them separately tells the operator exactly what to fix.
 *
 *   So every backing service gets a presence check (cheap, offline) AND a
 *   connectivity check (a single non-mutating read). The presence check short-
 *   circuits the connectivity check when the var is absent - there is nothing to
 *   reach, and we never want to print a confusing "connection refused" when the
 *   real problem is an unset var.
 *
 * CRITICAL vs ADVISORY classification follows the triple-write graceful-
 * degradation rule the rest of the system already lives by (see
 * .ai/data-stores.md, lib/triple-write.ts, the system.triple_write_degraded
 * event):
 *
 *   - CRITICAL = the app crash-loops or a core capability is dead without it.
 *     DATABASE_URL (source of truth), INSTINCT_JWT_SECRET (auth throws in prod),
 *     CRON_SECRET (scheduled jobs), and GitHub token validity (static scan +
 *     site remediation cannot run without it). A failed critical check => not ready.
 *   - ADVISORY = a degraded-but-running posture. Qdrant and Neo4j are the
 *     triple-write SECONDARY stores; if they are down, triple-write degrades to
 *     Postgres-only and emits system.triple_write_degraded - it never throws. So
 *     Qdrant/Neo4j presence + reachability are advisory, exactly mirroring that
 *     philosophy. Optional integrations (Resend, the Microsoft trio) are advisory
 *     too: missing them disables a feature, it does not crash the app.
 *
 * SECURITY: this never prints secret VALUES - only present/absent and a coarse
 * reachability verdict. Detail strings are safe to surface in an admin UI and a
 * CI log.
 *
 * Every check is non-destructive: a `SELECT 1`, a GET to a health/collections
 * endpoint, a trivial `RETURN 1` Cypher, and an authenticated GET /rate_limit.
 * Collaborators are injectable so tests never touch a real service.
 */

export interface ReadinessCheck {
  name: string;
  pass: boolean;
  detail: string;
  /** A failed critical check means the deployment is NOT ready; advisories do not. */
  critical: boolean;
}

export interface ReadinessResult {
  ok: boolean;
  checks: ReadinessCheck[];
}

/**
 * Injectable collaborators. Each pinger returns a typed verdict and NEVER
 * throws - the lib catches anything and turns it into a failed check, mirroring
 * the never-throw posture of the underlying clients (db.safeQuery,
 * qdrant/neo4j fire-and-forget). Tests pass fakes; production passes the real
 * client-backed pingers wired in `defaultReadinessDeps()`.
 */
export interface ReadinessDeps {
  /** Map of env var name -> value (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** SELECT 1 against Postgres. */
  pingPostgres?: () => Promise<{ ok: boolean; detail: string }>;
  /** Cheap non-mutating GET against Qdrant (health / collections). */
  pingQdrant?: () => Promise<{ ok: boolean; detail: string }>;
  /** Trivial RETURN 1 Cypher against Neo4j. */
  pingNeo4j?: () => Promise<{ ok: boolean; detail: string }>;
  /** Authenticated GET /rate_limit against GitHub. */
  pingGithub?: () => Promise<{ ok: boolean; detail: string }>;
}

/** Minimum length the JWT secret must be - short secrets are brute-forceable. */
const MIN_JWT_SECRET_LEN = 32;

/**
 * Env vars that gate readiness. `critical: true` => a missing value crash-loops
 * the app (or kills a core capability) and the deployment is NOT ready.
 * `critical: false` => an advisory: the var enables an optional integration; its
 * absence degrades a feature, it does not crash the app. Classification is taken
 * from .ai/client-context.md's blocker table + the triple-write degradation rule.
 */
const REQUIRED_ENV: Array<{ name: string; critical: boolean }> = [
  // Source of truth - absence => every query throws => crash loop.
  { name: "DATABASE_URL", critical: true },
  // NOTE: the auth secret is checked separately below (it has a legacy-name
  // fallback the app honors), so it is intentionally NOT in this generic loop.
  // Scheduled jobs (refresh, ingest) authenticate with this; absent => cron 401s.
  { name: "CRON_SECRET", critical: true },
  // Triple-write SECONDARY store - degrades gracefully, so ADVISORY.
  { name: "QDRANT_URL", critical: false },
  { name: "QDRANT_API_KEY", critical: false },
  // Triple-write SECONDARY store - degrades gracefully, so ADVISORY.
  { name: "NEO4J_URI", critical: false },
  { name: "NEO4J_USER", critical: false },
  { name: "NEO4J_PASSWORD", critical: false },
  // Sites module (static scan + remediation) - CRITICAL for that capability.
  { name: "GITHUB_TOKEN_WOLFPACK_AGENCY", critical: true },
  // Optional integration - disabling email is degraded, not a crash. ADVISORY.
  { name: "RESEND_API_KEY", critical: false },
  // Microsoft Graph OAuth - optional integration. ADVISORY (Graph routes surface
  // "service unavailable" rather than crash the app).
  { name: "MICROSOFT_CLIENT_ID", critical: false },
  { name: "MICROSOFT_CLIENT_SECRET", critical: false },
  { name: "MICROSOFT_TENANT_ID", critical: false },
];

/**
 * Run every readiness check. Pure given its deps; safe to call from a route, a
 * CI script (via a node one-liner), or a test. Returns ok=false iff any CRITICAL
 * check fails.
 */
export async function runDeploymentReadiness(
  deps: ReadinessDeps = {},
): Promise<ReadinessResult> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const checks: ReadinessCheck[] = [];
  const add = (name: string, pass: boolean, detail: string, critical: boolean) =>
    checks.push({ name, pass, detail, critical });

  // --- Env presence (cheap, offline) -------------------------------------
  for (const { name, critical } of REQUIRED_ENV) {
    const raw = env[name];
    const present = typeof raw === "string" && raw.trim().length > 0;
    // NEVER print the value - only present/absent.
    add(
      `env:${name}`,
      present,
      present
        ? `${name} is set.`
        : `${name} is missing.${critical ? " App will not start correctly without it." : " Optional integration disabled until set."}`,
      critical,
    );
  }

  // Auth secret. The app (src/lib/crypto/sign.ts) reads INSTINCT_JWT_SECRET and
  // FALLS BACK to the legacy APEX_JWT_SECRET (the pre-rename name). Mirror that
  // exactly so the check matches reality: ready when EITHER is set. Checking only
  // the new name reported a false NOT READY on deployments still on the legacy var.
  const newSecret = (env.INSTINCT_JWT_SECRET ?? "").trim();
  const legacySecret = (env.APEX_JWT_SECRET ?? "").trim();
  const effectiveSecret = newSecret || legacySecret;
  const jwtPresent = effectiveSecret.length > 0;
  const onLegacyOnly = newSecret.length === 0 && legacySecret.length > 0;
  add(
    "env:INSTINCT_JWT_SECRET",
    jwtPresent,
    jwtPresent
      ? onLegacyOnly
        ? "Auth secret is set via the legacy APEX_JWT_SECRET (works; see the advisory to migrate)."
        : "INSTINCT_JWT_SECRET is set."
      : "INSTINCT_JWT_SECRET (or legacy APEX_JWT_SECRET) is missing. App will not start correctly without it.",
    true,
  );
  // Length floor on top of presence: a short secret boots then is brute-forceable.
  if (jwtPresent) {
    const longEnough = effectiveSecret.length >= MIN_JWT_SECRET_LEN;
    add(
      "env:INSTINCT_JWT_SECRET_length",
      longEnough,
      longEnough
        ? `Auth secret meets the ${MIN_JWT_SECRET_LEN}-char minimum.`
        : `Auth secret is too short (needs >= ${MIN_JWT_SECRET_LEN} chars).`,
      true,
    );
  }
  // Advisory: nudge migrating off the legacy name. Set INSTINCT_JWT_SECRET to the
  // SAME value as APEX_JWT_SECRET (a different value invalidates every live session),
  // then remove the legacy var. Advisory, so it never blocks readiness.
  if (onLegacyOnly) {
    add(
      "env:jwt_secret_legacy_name",
      false,
      "Using the legacy APEX_JWT_SECRET. Set INSTINCT_JWT_SECRET to the SAME value, then remove the legacy var.",
      false,
    );
  }

  // --- Live connectivity (one non-mutating read each) --------------------
  //
  // A connectivity check runs only when BOTH (a) the env var is present (nothing
  // to reach otherwise - a "connection refused" would mislead) AND (b) a pinger
  // is wired. The route always wires pingers (defaultReadinessDeps), so it runs
  // the full live gate. The verify-prod-env.sh --local mode wires NO pingers, so
  // it cleanly degrades to an ENV-ONLY gate (CI runners often can't reach the
  // backing services pre-deploy); the live gate is the post-deploy step.
  //
  // When a var IS present but its pinger is absent in the ROUTE path, that is a
  // wiring bug, not an env-only run - but distinguishing the two without a flag
  // adds noise. We treat "no pinger" as "skip the live check"; the route's own
  // contract test proves the default deps are passed, closing that gap.

  // Postgres - CRITICAL. SELECT 1.
  if (env.DATABASE_URL && deps.pingPostgres) {
    const r = await safePing(deps.pingPostgres, "Postgres");
    add("connect:postgres", r.ok, r.detail, true);
  }

  // GitHub - CRITICAL (static scan + remediation). Authenticated GET /rate_limit.
  if (env.GITHUB_TOKEN_WOLFPACK_AGENCY && deps.pingGithub) {
    const r = await safePing(deps.pingGithub, "GitHub");
    add("connect:github", r.ok, r.detail, true);
  }

  // Qdrant - ADVISORY (triple-write secondary; degrades gracefully). Cheap GET.
  if (env.QDRANT_URL && deps.pingQdrant) {
    const r = await safePing(deps.pingQdrant, "Qdrant");
    add("connect:qdrant", r.ok, r.detail, false);
  }

  // Neo4j - ADVISORY (triple-write secondary; degrades gracefully). RETURN 1.
  if (env.NEO4J_URI && deps.pingNeo4j) {
    const r = await safePing(deps.pingNeo4j, "Neo4j");
    add("connect:neo4j", r.ok, r.detail, false);
  }

  const ok = checks.filter((c) => c.critical).every((c) => c.pass);
  return { ok, checks };
}

/**
 * Wrap a pinger so a thrown error becomes a failed check rather than crashing
 * the whole readiness run. Never leaks a secret: the caught message is from a
 * connection/auth failure, not a credential dump.
 */
async function safePing(
  ping: () => Promise<{ ok: boolean; detail: string }>,
  label: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    return await ping();
  } catch (err) {
    return { ok: false, detail: `${label} unreachable: ${(err as Error).message}` };
  }
}

/**
 * Production pingers wired to the real clients. Imported lazily so a unit test
 * that injects fakes never pulls in the pg pool / fetch. Each is non-mutating.
 */
export function defaultReadinessDeps(): ReadinessDeps {
  return {
    async pingPostgres() {
      const { query } = await import("@/lib/db");
      await query("SELECT 1");
      return { ok: true, detail: "Postgres answered SELECT 1." };
    },
    async pingQdrant() {
      const { getQdrantHealth } = await import("@/lib/qdrant");
      const up = await getQdrantHealth();
      return {
        ok: up,
        detail: up ? "Qdrant health check passed." : "Qdrant did not respond OK to its health endpoint.",
      };
    },
    async pingNeo4j() {
      const { getNeo4jHealth } = await import("@/lib/neo4j");
      const up = await getNeo4jHealth();
      return {
        ok: up,
        detail: up ? "Neo4j answered RETURN 1." : "Neo4j did not answer a trivial query.",
      };
    },
    async pingGithub() {
      const { defaultGithubClient } = await import("@/lib/github-client");
      const client = defaultGithubClient();
      const res = await client.fetch("https://api.github.com/rate_limit", {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${client.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "wolfpack-instinct-deploy-readiness",
        },
      });
      return {
        ok: res.ok,
        detail: res.ok
          ? "GitHub token is valid (GET /rate_limit succeeded)."
          : `GitHub token rejected (GET /rate_limit returned HTTP ${res.status}).`,
      };
    },
  };
}
