/**
 * Guardrail: every credential-shaped column a migration creates is either
 * sealed at rest (listed in ROTATION_TARGETS, so the key-rotation backfill
 * covers it) or explicitly classified below with a reason.
 *
 * A new column named like a token, secret, password, key or credential fails
 * this test until it is one of the two. That is the point: an unsealed OAuth
 * token column cannot be added without someone deciding, in review, that it
 * is fine.
 *
 * Tables renamed by the Apex to Instinct rename (apex_* -> instinct_*) are
 * matched under their current name.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROTATION_TARGETS } from "@/lib/crypto/secret-key-rotation";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "db", "migrations");
const CREDENTIAL_SHAPED = /(token|secret|password|api_?key|credential|_enc$|encrypted)/;

/** Credential-shaped columns that are deliberately not sealed by secret-storage. */
const CLASSIFIED: Record<string, string> = {
  "instinct_team_members.password_hash": "one-way hash",
  "instinct_password_resets.token_sha256": "one-way hash",
  "instinct_agents.onboarding_secret_hash": "one-way hash",
  "forcefield_tenants.token_sha256": "one-way hash",
  "forcefield_tenants.notify_confirm_token_sha256": "one-way hash (SHA-256 of the emailed alert-address confirmation token)",
  "instinct_target_verifications.verification_token": "published by the owner as proof of control; not a credential",
  "instinct_ms_sync_state.delta_token": "Graph delta-query cursor; grants nothing on its own",
  "instinct_invites.token": "one-way hash (SHA-256 via token-hash.ts; looked up by hash)",
};

function currentName(table: string): string {
  return table.replace(/^apex_/, "instinct_");
}

/** Every (table.column) a forward migration creates whose name looks like a credential. */
function credentialShapedColumns(): Set<string> {
  const found = new Set<string>();
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"));
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8").replace(/--[^\n]*/g, "");
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_0-9]+)"?\s*\(([\s\S]*?)\n\s*\)\s*;/gi)) {
      for (const line of m[2].split("\n")) {
        const c = line.trim().match(/^"?([a-z_0-9]+)"?\s+(text|varchar|character\s+varying|bytea|jsonb)\b/i);
        if (c && CREDENTIAL_SHAPED.test(c[1].toLowerCase())) found.add(`${currentName(m[1].toLowerCase())}.${c[1].toLowerCase()}`);
      }
    }
    for (const m of sql.matchAll(/ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?([a-z_0-9]+)"?([\s\S]*?);/gi)) {
      for (const a of m[2].matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_0-9]+)"?\s+(text|varchar|character\s+varying|bytea|jsonb)\b/gi)) {
        if (CREDENTIAL_SHAPED.test(a[1].toLowerCase())) found.add(`${currentName(m[1].toLowerCase())}.${a[1].toLowerCase()}`);
      }
    }
  }
  return found;
}

const SEALED = new Set(ROTATION_TARGETS.flatMap((t) => t.columns.map((c) => `${t.table}.${c}`)));

describe("at-rest secret columns", () => {
  const found = credentialShapedColumns();

  it("finds the columns it is meant to police (parser sanity)", () => {
    expect(found.has("instinct_ms_tokens.access_token")).toBe(true);
    expect(found.has("instinct_qbo_tokens.refresh_token")).toBe(true);
    expect(found.has("instinct_connector_credentials.refresh_token_enc")).toBe(true);
  });

  it("every credential-shaped column is sealed (ROTATION_TARGETS) or classified with a reason", () => {
    const unclassified = [...found].filter((c) => !SEALED.has(c) && !(c in CLASSIFIED)).sort();
    expect(unclassified).toEqual([]);
  });

  it("every classification is a hash or a non-credential; there is no baseline of exceptions", () => {
    for (const [col, reason] of Object.entries(CLASSIFIED)) {
      expect([col, /^(one-way hash|published by the owner|Graph delta-query cursor)/.test(reason)]).toEqual([col, true]);
    }
  });

  it("OAuth token stores and shared signing secrets are sealed, not classified", () => {
    for (const c of [
      "instinct_ms_tokens.access_token",
      "instinct_ms_tokens.refresh_token",
      "instinct_qbo_tokens.access_token",
      "instinct_qbo_tokens.refresh_token",
      "instinct_delegation_issuers.secret",
    ]) {
      expect(SEALED.has(c)).toBe(true);
      expect(c in CLASSIFIED).toBe(false);
    }
  });

  it("the classification list has no stale entries", () => {
    const stale = Object.keys(CLASSIFIED).filter((c) => !found.has(c) || SEALED.has(c));
    expect(stale).toEqual([]);
  });

  it("every ROTATION_TARGETS column exists in a migration (no typo hides an unsealed column)", () => {
    /* instinct_ms_tokens / instinct_qbo_tokens / instinct_connector_credentials
       etc. must all be found by the same parser that polices new columns. */
    const missing = [...SEALED].filter((c) => !found.has(c));
    expect(missing).toEqual([]);
  });
});
