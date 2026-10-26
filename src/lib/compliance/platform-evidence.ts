/**
 * Platform evidence: measured, read-only facts about the platform's own
 * security controls, shared by the compliance crosswalk and the security-posture
 * parity check (one collector, so the two can never disagree).
 *
 * Each fact is read from the live database or the running process, never from a
 * doc or a config flag alone:
 *   - stored OAuth tokens, connector credentials and MFA seeds: how many are NOT
 *     ciphertext, and how many are not sealed under the deployment's dedicated
 *     primary key (plaintext, legacy-key or previous-key values all count)
 *   - row-level security: are policies real (not USING(true)), forced, and does
 *     the connecting role bypass them
 *   - gate decisions in a window: how many were ENFORCED blocks / escalations
 *   - ledger checkpoints: were any actually signed in the window
 *   - the at-rest key source: a dedicated key, one derived from the JWT secret,
 *     or the development literal
 *
 * A failed read yields null (unknown), never a passing default.
 */
import { parseSecretKeyMaterial, secretKeyId } from "@/lib/crypto/secret-storage";
import { runEvidenceProbe, type EvidenceExecutor, type EvidenceProbe } from "./evidence-window";

export type KekSource = "dedicated" | "derived-from-jwt" | "dev-literal";

export interface StoredSecretCount {
  total: number;
  /** Rows whose secret column is present but not a v1.* ciphertext token. */
  plaintext: number;
  /** Rows with a secret present that is not sealed under the primary key
   *  (INSTINCT_SECRET_KEY): plaintext, legacy-key and previous-key values all
   *  count. With no valid primary key every row with a secret counts. */
  offPrimaryKey: number;
}

export interface RlsPosture {
  tables: number;
  rlsEnabled: number;
  forced: number;
  policies: number;
  /** Policies whose USING clause is anything other than `true`. */
  nonTrivialPolicies: number;
  /** The connecting role has BYPASSRLS or is a superuser. */
  roleBypassesRls: boolean;
  /** Tables owned by the connecting role (owners bypass unless FORCE is set). */
  ownedByRole: number;
}

export interface GateWindow {
  windowDays: number;
  decisions: number;
  /** Decisions taken in enforce mode (enforced = true). */
  enforced: number;
  /** Enforced decisions whose effective outcome was deny or escalate. */
  enforcedBlocks: number;
  /** Enforced decisions whose effective outcome was escalate (a human was asked). */
  enforcedEscalations: number;
  /** Decisions the gate WOULD have blocked (monitor included). */
  wouldBlock: number;
}

export interface PlatformEvidence {
  oauthTokens: StoredSecretCount | null;
  connectorCredentials: StoredSecretCount | null;
  /** instinct_admin_mfa.encrypted_secret (TOTP seeds) for the workspace. */
  mfaSeeds: StoredSecretCount | null;
  rls: RlsPosture | null;
  gate: GateWindow | null;
  signedCheckpoints: EvidenceProbe;
  kekSource: KekSource;
}

export const GATE_WINDOW_DAYS = 30;
export const CHECKPOINT_WINDOW_DAYS = 7;

/** Where the at-rest key comes from. Mirrors the resolution order in
 *  src/lib/crypto/secret-storage.ts (INSTINCT_SECRET_KEY, else derived from
 *  INSTINCT_JWT_SECRET, else the "instinct-dev-only" literal). */
export function kekSource(env: Record<string, string | undefined> = process.env): KekSource {
  const raw = env.INSTINCT_SECRET_KEY;
  if (raw && raw.length >= 32) {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) return "dedicated";
    try {
      if (Buffer.from(raw, "base64").length === 32) return "dedicated";
    } catch {
      /* fall through */
    }
  }
  return env.INSTINCT_JWT_SECRET ? "derived-from-jwt" : "dev-literal";
}

/** LIKE pattern matching a value sealed under the primary key in `env`
 *  ("v1.<kid>.%", secret-storage.ts token format). With no valid primary key it
 *  is "", which no present value matches, so every present value counts as off
 *  the primary key: the check fails closed. The key id names the key without
 *  revealing it. */
export function primaryKeyPattern(env: Record<string, string | undefined> = process.env): string {
  const key = parseSecretKeyMaterial(env.INSTINCT_SECRET_KEY);
  return key ? `v1.${secretKeyId(key)}.%` : "";
}

/** count(*) FILTER clauses for a table's secret columns: plaintext and
 *  off-primary-key rows. $pattern is the bind placeholder for primaryKeyPattern. */
function secretCountSql(columns: string[], pattern: string): string {
  const present = (c: string) => `${c} IS NOT NULL AND ${c} <> ''`;
  const plain = columns.map((c) => `(${present(c)} AND ${c} NOT LIKE 'v1.%')`).join(" OR ");
  const off = columns.map((c) => `(${present(c)} AND ${c} NOT LIKE ${pattern})`).join(" OR ");
  return `count(*) AS total, count(*) FILTER (WHERE ${plain}) AS plaintext, count(*) FILTER (WHERE ${off}) AS off_primary`;
}

const n = (v: unknown): number => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export async function collectPlatformEvidence(
  workspaceId: string,
  exec: EvidenceExecutor | null,
  nowMs: number = Date.now(),
  env: Record<string, string | undefined> = process.env,
): Promise<PlatformEvidence> {
  const signedCheckpoints = await runEvidenceProbe(
    {
      key: "signing.checkpoints_signed",
      proof: "ogiam_checkpoints with a real algorithm and a signature",
      windowDays: CHECKPOINT_WINDOW_DAYS,
      sql: `SELECT count(*) FILTER (WHERE created_at > now() - ($1 || ' days')::interval) AS n, max(created_at) AS last
              FROM ogiam_checkpoints
             WHERE workspace_id = $3 AND algorithm <> 'none' AND signature IS NOT NULL
               AND created_at > now() - ($2 || ' days')::interval`,
      params: [workspaceId],
    },
    exec,
    nowMs,
  );

  if (!exec) {
    return { oauthTokens: null, connectorCredentials: null, mfaSeeds: null, rls: null, gate: null, signedCheckpoints, kekSource: kekSource(env) };
  }

  const pattern = primaryKeyPattern(env);
  const counted = (row: Record<string, unknown> | undefined): StoredSecretCount => ({
    total: n(row?.total),
    plaintext: n(row?.plaintext),
    offPrimaryKey: n(row?.off_primary),
  });

  const [oauthTokens, connectorCredentials, mfaSeeds, rls, gate] = await Promise.all([
    attempt(async (): Promise<StoredSecretCount> => {
      // Microsoft Graph and QuickBooks tokens are deployment-wide stores (no
      // workspace column); only counts are read, never a token value.
      const ms = await exec(`SELECT ${secretCountSql(["access_token", "refresh_token"], "$1")} FROM instinct_ms_tokens`, [pattern]);
      const qbo = await exec(`SELECT ${secretCountSql(["access_token", "refresh_token"], "$1")} FROM instinct_qbo_tokens`, [pattern]);
      const a = counted(ms.rows[0]);
      const b = counted(qbo.rows[0]);
      return { total: a.total + b.total, plaintext: a.plaintext + b.plaintext, offPrimaryKey: a.offPrimaryKey + b.offPrimaryKey };
    }),
    attempt(async (): Promise<StoredSecretCount> => {
      const r = await exec(
        `SELECT ${secretCountSql(["auth_header_enc", "refresh_token_enc"], "$2")}
           FROM instinct_connector_credentials
          WHERE workspace_id = $1`,
        [workspaceId, pattern],
      );
      return counted(r.rows[0]);
    }),
    attempt(async (): Promise<StoredSecretCount> => {
      const r = await exec(
        `SELECT ${secretCountSql(["encrypted_secret"], "$2")}
           FROM instinct_admin_mfa
          WHERE workspace_id = $1`,
        [workspaceId, pattern],
      );
      return counted(r.rows[0]);
    }),
    attempt(async (): Promise<RlsPosture> => {
      const r = await exec(
        `SELECT
           (SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
             WHERE ns.nspname = 'public' AND c.relkind = 'r') AS tables,
           (SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
             WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity) AS rls_enabled,
           (SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
             WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relforcerowsecurity) AS forced,
           (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS policies,
           (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
              AND coalesce(btrim(qual), 'true') NOT IN ('true', '(true)')) AS non_trivial,
           (SELECT (rolbypassrls OR rolsuper) FROM pg_roles WHERE rolname = current_user) AS bypass,
           (SELECT count(*) FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
             WHERE ns.nspname = 'public' AND c.relkind = 'r' AND pg_get_userbyid(c.relowner) = current_user) AS owned`,
        [],
      );
      const row = r.rows[0] ?? {};
      return {
        tables: n(row.tables),
        rlsEnabled: n(row.rls_enabled),
        forced: n(row.forced),
        policies: n(row.policies),
        nonTrivialPolicies: n(row.non_trivial),
        roleBypassesRls: row.bypass === true,
        ownedByRole: n(row.owned),
      };
    }),
    attempt(async (): Promise<GateWindow> => {
      const r = await exec(
        `SELECT count(*) AS decisions,
                count(*) FILTER (WHERE enforced) AS enforced,
                count(*) FILTER (WHERE enforced AND effective_outcome IN ('deny', 'escalate')) AS enforced_blocks,
                count(*) FILTER (WHERE enforced AND effective_outcome = 'escalate') AS enforced_escalations,
                count(*) FILTER (WHERE would_block) AS would_block
           FROM ogiam_decisions
          WHERE workspace_id = $1 AND created_at > now() - ($2 || ' days')::interval
            AND surface NOT IN ('/redteam', '/selftest')`,
        [workspaceId, String(GATE_WINDOW_DAYS)],
      );
      const row = r.rows[0] ?? {};
      return {
        windowDays: GATE_WINDOW_DAYS,
        decisions: n(row.decisions),
        enforced: n(row.enforced),
        enforcedBlocks: n(row.enforced_blocks),
        enforcedEscalations: n(row.enforced_escalations),
        wouldBlock: n(row.would_block),
      };
    }),
  ]);

  return { oauthTokens, connectorCredentials, mfaSeeds, rls, gate, signedCheckpoints, kekSource: kekSource(env) };
}

/** Database-level tenant isolation is real only when policies key on something
 *  other than `true`, at least one table forces RLS, and the connecting role
 *  does not bypass it. Pure. */
export function dbRlsEnforced(rls: RlsPosture | null): boolean | null {
  if (!rls) return null;
  return rls.nonTrivialPolicies > 0 && rls.forced > 0 && !rls.roleBypassesRls;
}
