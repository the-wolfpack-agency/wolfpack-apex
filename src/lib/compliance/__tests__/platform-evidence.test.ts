/**
 * The at-rest secret counts behind secrets.app_encrypted and
 * secrets.oauth_tokens_encrypted: a value counts as sealed under the dedicated
 * key only when it carries the primary key's id, and with no valid primary key
 * every stored value counts against the claim (fail closed).
 */
import { randomBytes } from "node:crypto";
import { collectPlatformEvidence, primaryKeyPattern } from "../platform-evidence";
import { __resetSecretKeyCacheForTests, encryptSecret, parseSecretKeyMaterial, secretKeyId } from "@/lib/crypto/secret-storage";
import type { EvidenceExecutor } from "../evidence-window";

const KEY_HEX = randomBytes(32).toString("hex");

/** SQL LIKE with only a trailing % (the only wildcard the pattern uses). */
const likeMatches = (value: string, pattern: string) =>
  pattern.endsWith("%") ? value.startsWith(pattern.slice(0, -1)) : value === pattern;

describe("primaryKeyPattern", () => {
  it("names the primary key by its id, never the key itself", () => {
    const p = primaryKeyPattern({ INSTINCT_SECRET_KEY: KEY_HEX });
    expect(p).toBe(`v1.${secretKeyId(parseSecretKeyMaterial(KEY_HEX)!)}.%`);
    expect(p).not.toContain(KEY_HEX);
  });

  it.each([
    ["unset", {}],
    ["too short", { INSTINCT_SECRET_KEY: "abc" }],
    ["a redaction placeholder", { INSTINCT_SECRET_KEY: "[SENSITIVE VALUE REDACTED BY VERCEL CLI]" }],
  ])("is empty when the primary key is %s, so no stored value matches", (_l, env) => {
    expect(primaryKeyPattern(env)).toBe("");
  });

  describe("against real ciphertext", () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
      __resetSecretKeyCacheForTests();
    });

    it("a value sealed under the primary key matches; a legacy-key value does not", () => {
      const pattern = primaryKeyPattern({ INSTINCT_SECRET_KEY: KEY_HEX });

      process.env = { ...saved, INSTINCT_SECRET_KEY: KEY_HEX, INSTINCT_JWT_SECRET: "j".repeat(40) };
      __resetSecretKeyCacheForTests();
      expect(likeMatches(encryptSecret("s"), pattern)).toBe(true);

      process.env = { ...saved, INSTINCT_JWT_SECRET: "j".repeat(40) };
      delete process.env.INSTINCT_SECRET_KEY;
      __resetSecretKeyCacheForTests();
      const legacy = encryptSecret("s");
      expect(legacy.startsWith("v1.")).toBe(true);
      expect(likeMatches(legacy, pattern)).toBe(false);
    });

    it("a value under a different (previous) key does not match", () => {
      const other = randomBytes(32).toString("hex");
      process.env = { ...saved, INSTINCT_SECRET_KEY: other };
      __resetSecretKeyCacheForTests();
      expect(likeMatches(encryptSecret("s"), primaryKeyPattern({ INSTINCT_SECRET_KEY: KEY_HEX }))).toBe(false);
    });
  });
});

describe("collectPlatformEvidence secret counts", () => {
  function recordingExec(rows: Record<string, Record<string, unknown>>) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const exec: EvidenceExecutor = async (sql, params) => {
      calls.push({ sql, params: params ?? [] });
      for (const [table, row] of Object.entries(rows)) if (sql.includes(`FROM ${table}`)) return { rows: [row] };
      return { rows: [{}] };
    };
    return { exec, calls };
  }

  it("binds the primary-key pattern and reads off-primary counts for OAuth tokens, connector credentials and MFA seeds", async () => {
    const { exec, calls } = recordingExec({
      instinct_ms_tokens: { total: 6, plaintext: 0, off_primary: 1 },
      instinct_qbo_tokens: { total: 2, plaintext: 1, off_primary: 2 },
      instinct_connector_credentials: { total: 4, plaintext: 0, off_primary: 0 },
      instinct_admin_mfa: { total: 1, plaintext: 0, off_primary: 1 },
    });
    const env = { INSTINCT_SECRET_KEY: KEY_HEX };
    const e = await collectPlatformEvidence("w1", exec, Date.now(), env);
    expect(e.oauthTokens).toEqual({ total: 8, plaintext: 1, offPrimaryKey: 3 });
    expect(e.connectorCredentials).toEqual({ total: 4, plaintext: 0, offPrimaryKey: 0 });
    expect(e.mfaSeeds).toEqual({ total: 1, plaintext: 0, offPrimaryKey: 1 });
    expect(e.kekSource).toBe("dedicated");

    const pattern = primaryKeyPattern(env);
    for (const table of ["instinct_connector_credentials", "instinct_admin_mfa"]) {
      const c = calls.find((x) => x.sql.includes(`FROM ${table}`))!;
      expect(c.sql).toMatch(/WHERE workspace_id = \$1/);
      expect(c.sql).toMatch(/NOT LIKE \$2/);
      expect(c.params).toEqual(["w1", pattern]);
    }
    for (const table of ["instinct_ms_tokens", "instinct_qbo_tokens"]) {
      const c = calls.find((x) => x.sql.includes(`FROM ${table}`))!;
      expect(c.params).toEqual([pattern]);
    }
    // Only counts are selected: no secret column is ever returned.
    for (const c of calls.filter((x) => /instinct_(ms|qbo)_tokens|connector_credentials|admin_mfa/.test(x.sql))) {
      expect(c.sql.trim()).toMatch(/^SELECT count\(\*\) AS total,/);
    }
  });

  it("with no primary key the bound pattern is empty, so the off-primary filter counts every stored value", async () => {
    const { exec, calls } = recordingExec({});
    await collectPlatformEvidence("w1", exec, Date.now(), { INSTINCT_JWT_SECRET: "j".repeat(40) });
    const c = calls.find((x) => x.sql.includes("FROM instinct_admin_mfa"))!;
    expect(c.params).toEqual(["w1", ""]);
  });

  it("a failed read is unknown (null), never a passing zero", async () => {
    const exec: EvidenceExecutor = async (sql) => {
      if (sql.includes("FROM instinct_admin_mfa")) throw new Error("relation does not exist");
      return { rows: [{}] };
    };
    const e = await collectPlatformEvidence("w1", exec, Date.now(), { INSTINCT_SECRET_KEY: KEY_HEX });
    expect(e.mfaSeeds).toBeNull();
  });
});
