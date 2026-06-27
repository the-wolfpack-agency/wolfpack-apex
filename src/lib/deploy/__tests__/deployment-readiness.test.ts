/**
 * Unit tests for runDeploymentReadiness - the deployment readiness gate.
 *
 * Proves:
 *   - all env present + every service reachable -> ok:true.
 *   - a missing CRITICAL env var (DATABASE_URL) -> ok:false (not ready).
 *   - a missing ADVISORY env var (QDRANT_URL) -> still ok:true (degraded only).
 *   - INSTINCT_JWT_SECRET present but < 32 chars -> a critical length check fails.
 *   - service unreachable: Postgres/GitHub down (critical) -> ok:false; Qdrant/
 *     Neo4j down (advisory) -> ok:true. The critical/advisory split is exact.
 *   - a pinger that THROWS becomes a failed check, not a crashed run.
 *   - no secret VALUE ever appears in a detail string.
 *
 * Env + every service client are injected via deps - never a real service.
 */

import { runDeploymentReadiness, type ReadinessDeps } from "@/lib/deploy/deployment-readiness";

const LONG_SECRET = "x".repeat(40);

const FULL_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://u:p@host/db",
  INSTINCT_JWT_SECRET: LONG_SECRET,
  CRON_SECRET: "cron-secret-value",
  QDRANT_URL: "https://qdrant.example",
  QDRANT_API_KEY: "qdrant-key",
  NEO4J_URI: "bolt://neo4j.example:7687",
  NEO4J_USER: "neo4j",
  NEO4J_PASSWORD: "neo4j-pass",
  GITHUB_TOKEN_WOLFPACK_AGENCY: "ghp_token",
  RESEND_API_KEY: "re_key",
  MICROSOFT_CLIENT_ID: "ms-client",
  MICROSOFT_CLIENT_SECRET: "ms-secret",
  MICROSOFT_TENANT_ID: "ms-tenant",
};

const ok = (detail: string) => async () => ({ ok: true, detail });
const down = (detail: string) => async () => ({ ok: false, detail });

function allUpDeps(env: Record<string, string | undefined> = FULL_ENV): ReadinessDeps {
  return {
    env,
    pingPostgres: ok("Postgres answered SELECT 1."),
    pingQdrant: ok("Qdrant health check passed."),
    pingNeo4j: ok("Neo4j answered RETURN 1."),
    pingGithub: ok("GitHub token is valid."),
  };
}

function check(result: { checks: { name: string; detail: string }[] }, name: string) {
  return result.checks.find((c) => c.name === name);
}

describe("runDeploymentReadiness", () => {
  it("all env present + every service up -> ok:true, env + connect checks all pass", async () => {
    const result = await runDeploymentReadiness(allUpDeps());
    expect(result.ok).toBe(true);
    expect(check(result, "env:DATABASE_URL")).toMatchObject({ pass: true, critical: true });
    expect(check(result, "env:QDRANT_URL")).toMatchObject({ pass: true, critical: false });
    expect(check(result, "connect:postgres")).toMatchObject({ pass: true, critical: true });
    expect(check(result, "connect:github")).toMatchObject({ pass: true, critical: true });
    expect(check(result, "connect:qdrant")).toMatchObject({ pass: true, critical: false });
    expect(check(result, "connect:neo4j")).toMatchObject({ pass: true, critical: false });
    // Every critical check passed.
    expect(result.checks.filter((c) => c.critical).every((c) => c.pass)).toBe(true);
  });

  it("missing CRITICAL env (DATABASE_URL) -> ok:false and the env check fails critical", async () => {
    const env = { ...FULL_ENV };
    delete (env as Record<string, string | undefined>).DATABASE_URL;
    const result = await runDeploymentReadiness(allUpDeps(env));
    expect(result.ok).toBe(false);
    expect(check(result, "env:DATABASE_URL")).toMatchObject({ pass: false, critical: true });
    // No DATABASE_URL -> the Postgres connectivity check is skipped entirely.
    expect(check(result, "connect:postgres")).toBeUndefined();
  });

  it("missing ADVISORY env (QDRANT_URL) -> still ok:true; the env check fails non-critical", async () => {
    const env = { ...FULL_ENV };
    delete (env as Record<string, string | undefined>).QDRANT_URL;
    const result = await runDeploymentReadiness(allUpDeps(env));
    expect(result.ok).toBe(true);
    expect(check(result, "env:QDRANT_URL")).toMatchObject({ pass: false, critical: false });
    expect(check(result, "connect:qdrant")).toBeUndefined();
  });

  it("INSTINCT_JWT_SECRET present but too short -> the length check fails critical, ok:false", async () => {
    const env = { ...FULL_ENV, INSTINCT_JWT_SECRET: "short" };
    const result = await runDeploymentReadiness(allUpDeps(env));
    expect(check(result, "env:INSTINCT_JWT_SECRET")).toMatchObject({ pass: true });
    expect(check(result, "env:INSTINCT_JWT_SECRET_length")).toMatchObject({ pass: false, critical: true });
    expect(result.ok).toBe(false);
  });

  it("missing INSTINCT_JWT_SECRET -> presence fails; length check is not added", async () => {
    const env = { ...FULL_ENV };
    delete (env as Record<string, string | undefined>).INSTINCT_JWT_SECRET;
    const result = await runDeploymentReadiness(allUpDeps(env));
    expect(check(result, "env:INSTINCT_JWT_SECRET")).toMatchObject({ pass: false, critical: true });
    expect(check(result, "env:INSTINCT_JWT_SECRET_length")).toBeUndefined();
    expect(result.ok).toBe(false);
  });

  it("CRITICAL service down (Postgres) -> ok:false", async () => {
    const deps = { ...allUpDeps(), pingPostgres: down("Postgres unreachable: connection refused") };
    const result = await runDeploymentReadiness(deps);
    expect(check(result, "connect:postgres")).toMatchObject({ pass: false, critical: true });
    expect(result.ok).toBe(false);
  });

  it("CRITICAL service down (GitHub token rejected) -> ok:false", async () => {
    const deps = { ...allUpDeps(), pingGithub: down("GitHub token rejected (HTTP 401).") };
    const result = await runDeploymentReadiness(deps);
    expect(check(result, "connect:github")).toMatchObject({ pass: false, critical: true });
    expect(result.ok).toBe(false);
  });

  it("ADVISORY services down (Qdrant + Neo4j) -> ok stays true (graceful degradation)", async () => {
    const deps = {
      ...allUpDeps(),
      pingQdrant: down("Qdrant did not respond OK."),
      pingNeo4j: down("Neo4j did not answer."),
    };
    const result = await runDeploymentReadiness(deps);
    expect(check(result, "connect:qdrant")).toMatchObject({ pass: false, critical: false });
    expect(check(result, "connect:neo4j")).toMatchObject({ pass: false, critical: false });
    expect(result.ok).toBe(true);
  });

  it("a pinger that THROWS becomes a failed check, not a crashed run", async () => {
    const deps = {
      ...allUpDeps(),
      pingPostgres: async () => {
        throw new Error("ETIMEDOUT");
      },
    };
    const result = await runDeploymentReadiness(deps);
    expect(check(result, "connect:postgres")).toMatchObject({ pass: false, critical: true });
    expect(check(result, "connect:postgres")?.detail).toContain("unreachable");
    expect(result.ok).toBe(false);
  });

  it("env-only mode (no pingers wired) -> connectivity checks are SKIPPED; ok rests on env alone", async () => {
    // verify-prod-env.sh --local runs this way: prove ENV completeness pre-deploy
    // when the CI runner can't reach the backing services. With all critical env
    // present, that is enough to be ready.
    const result = await runDeploymentReadiness({ env: FULL_ENV });
    expect(check(result, "connect:postgres")).toBeUndefined();
    expect(check(result, "connect:github")).toBeUndefined();
    expect(check(result, "connect:qdrant")).toBeUndefined();
    expect(check(result, "connect:neo4j")).toBeUndefined();
    expect(result.ok).toBe(true);
  });

  it("env-only mode with a missing critical env -> ok:false even without pingers", async () => {
    const env = { ...FULL_ENV };
    delete (env as Record<string, string | undefined>).CRON_SECRET;
    const result = await runDeploymentReadiness({ env });
    expect(check(result, "env:CRON_SECRET")).toMatchObject({ pass: false, critical: true });
    expect(result.ok).toBe(false);
  });

  it("never prints a secret VALUE in any detail string", async () => {
    const result = await runDeploymentReadiness(allUpDeps());
    const allDetail = result.checks.map((c) => c.detail).join("\n");
    for (const value of Object.values(FULL_ENV)) {
      expect(allDetail).not.toContain(value);
    }
  });

  it("empty env -> all critical env checks fail, ok:false, no connectivity checks attempted", async () => {
    const result = await runDeploymentReadiness({
      env: {},
      pingPostgres: ok("should not run"),
      pingGithub: ok("should not run"),
    });
    expect(result.ok).toBe(false);
    expect(check(result, "env:DATABASE_URL")).toMatchObject({ pass: false, critical: true });
    expect(check(result, "connect:postgres")).toBeUndefined();
    expect(check(result, "connect:github")).toBeUndefined();
  });
});
