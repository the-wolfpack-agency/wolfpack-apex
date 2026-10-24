/**
 * Incident response: end a leaked Instinct refresh-token family.
 *
 * An Instinct session is an access JWT (15 minutes) plus a refresh token (7
 * days). The refresh token's cookie value IS the row id in
 * instinct_refresh_tokens, and every rotation stays in the same family_id. So
 * a leaked refresh cookie is ended by revoking its family: the next refresh
 * with any token in it fails, and the leaked access JWT dies within 15 minutes.
 *
 * Everything here takes its database and side effects as arguments so the
 * planning, the SQL and the dry-run default are testable without a database.
 * The runner (scripts/security/revoke-session.ts) passes the real `query`,
 * `revokeFamilyTokens`, `trackEventAwait` and `recordAudit`.
 *
 * THE TOKEN IS NEVER PRINTED. It is read from a file (so it is not on a command
 * line, in shell history or in chat), used as a query parameter, and dropped.
 * Output names the family id, the user id and the row states only.
 */

export type QueryFn = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export interface RevokeArgs {
  tokenFile: string | null;
  userId: string | null;
  apply: boolean;
  reason: string;
}

export const USAGE = [
  "Usage:",
  "  npm run security:revoke-session -- --token-file <path> [--apply] [--reason <text>]",
  "  npm run security:revoke-session -- --user-id <id> [--apply] [--reason <text>]",
  "",
  "Dry run by default: shows what would be revoked. --apply writes.",
  "The token file holds the instinct_refresh_token value (a UUID), a",
  "'instinct_refresh_token=<uuid>' cookie line, or a Playwright storage-state JSON.",
  "Needs DATABASE_URL in the environment.",
].join("\n");

export function parseRevokeArgs(argv: string[]): RevokeArgs | { error: string } {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const v = argv[i + 1];
    return v && !v.startsWith("--") ? v : "";
  };
  for (const a of argv) {
    if (a.startsWith("--") && !["--token-file", "--user-id", "--apply", "--dry-run", "--reason"].includes(a)) {
      return { error: `Unknown flag ${a}. ${a === "--token" ? "Pass the token in a file with --token-file, never on the command line." : ""}`.trim() };
    }
  }
  const tokenFile = get("--token-file");
  const userId = get("--user-id");
  if (tokenFile === "" || userId === "") return { error: "--token-file and --user-id need a value." };
  if (!tokenFile && !userId) return { error: "Pass --token-file <path> or --user-id <id>." };
  if (tokenFile && userId) return { error: "Pass --token-file or --user-id, not both." };
  if (argv.includes("--apply") && argv.includes("--dry-run")) return { error: "--apply and --dry-run contradict each other." };
  return { tokenFile, userId, apply: argv.includes("--apply"), reason: get("--reason") || "leaked session" };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Pull the refresh-token id out of what an operator pastes into the file: the
 * bare value, a cookie line, or a Playwright storage-state / trace JSON.
 */
export function extractTokenId(content: string): string | null {
  const cookie = /instinct_refresh_token=([0-9a-f-]{36})/i.exec(content);
  if (cookie && UUID.test(cookie[1])) return cookie[1].toLowerCase();
  const json = /"name"\s*:\s*"instinct_refresh_token"\s*,\s*"value"\s*:\s*"([0-9a-f-]{36})"/i.exec(content);
  if (json && UUID.test(json[1])) return json[1].toLowerCase();
  const bare = content.trim();
  if (/^[0-9a-f-]{36}$/i.test(bare) && UUID.test(bare)) return bare.toLowerCase();
  return null;
}

export const TOKEN_FAMILY_SQL = `SELECT family_id, user_id FROM instinct_refresh_tokens WHERE id = $1`;

export const USER_FAMILIES_SQL = `SELECT DISTINCT family_id, user_id FROM instinct_refresh_tokens
 WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`;

export const FAMILY_ROWS_SQL = `SELECT issued_at, expires_at, used_at, revoked_at FROM instinct_refresh_tokens
 WHERE family_id = $1 ORDER BY issued_at ASC`;

export interface FamilyRow {
  issuedAt: string;
  expiresAt: string;
  used: boolean;
  revoked: boolean;
  live: boolean;
}

export interface FamilyPlan {
  familyId: string;
  userId: string;
  rows: FamilyRow[];
  /** Rows the UPDATE will touch (revoked_at IS NULL). */
  unrevoked: number;
  /** Rows that could still be refreshed right now. */
  live: number;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : v == null ? "" : String(v));

export async function familyPlan(q: QueryFn, familyId: string, userId: string, now: Date = new Date()): Promise<FamilyPlan> {
  const r = await q(FAMILY_ROWS_SQL, [familyId]);
  const rows: FamilyRow[] = r.rows.map((x) => {
    const revoked = x.revoked_at != null;
    const expiresAt = iso(x.expires_at);
    return {
      issuedAt: iso(x.issued_at),
      expiresAt,
      used: x.used_at != null,
      revoked,
      live: !revoked && x.used_at == null && new Date(expiresAt).getTime() > now.getTime(),
    };
  });
  return {
    familyId,
    userId,
    rows,
    unrevoked: rows.filter((x) => !x.revoked).length,
    live: rows.filter((x) => x.live).length,
  };
}

export type PlanResult = { ok: true; plans: FamilyPlan[] } | { ok: false; message: string };

export async function planRevocation(q: QueryFn, target: { tokenId: string } | { userId: string }, now: Date = new Date()): Promise<PlanResult> {
  let families: { familyId: string; userId: string }[];
  if ("tokenId" in target) {
    const r = await q(TOKEN_FAMILY_SQL, [target.tokenId]);
    if (!r.rows.length) return { ok: false, message: "No refresh token with that value exists in this database. Check DATABASE_URL points at the right deployment." };
    families = [{ familyId: String(r.rows[0].family_id), userId: String(r.rows[0].user_id) }];
  } else {
    const r = await q(USER_FAMILIES_SQL, [target.userId]);
    families = r.rows.map((x) => ({ familyId: String(x.family_id), userId: String(x.user_id) }));
  }
  const plans: FamilyPlan[] = [];
  for (const f of families) plans.push(await familyPlan(q, f.familyId, f.userId, now));
  return { ok: true, plans };
}

export function renderPlan(plans: FamilyPlan[], apply: boolean): string {
  const lines: string[] = [];
  lines.push(apply ? "APPLY: revoking the families below." : "DRY RUN: nothing is written. Re-run with --apply to revoke.");
  if (!plans.length) {
    lines.push("No live refresh-token family matched. Nothing to revoke.");
    return lines.join("\n");
  }
  for (const p of plans) {
    lines.push("");
    lines.push(`family ${p.familyId}  user ${p.userId}  rows ${p.rows.length}  unrevoked ${p.unrevoked}  live ${p.live}`);
    for (const r of p.rows) {
      const state = r.revoked ? "revoked" : r.used ? "used (rotated)" : r.live ? "LIVE" : "expired";
      lines.push(`  issued ${r.issuedAt}  expires ${r.expiresAt}  ${state}`);
    }
    if (p.unrevoked === 0) lines.push("  already fully revoked; no change.");
  }
  return lines.join("\n");
}

export interface ApplyDeps {
  /** revokeFamilyTokens from src/lib/crypto/refresh-tokens.ts. */
  revokeFamily: (familyId: string) => Promise<void>;
  track: (event: "security.session_family_revoked", userId: string, role: string, meta: Record<string, string | number | boolean>) => Promise<void>;
  audit: (entry: { actor: { user_id: string; role: string }; action: string; resourceType: string; resourceId?: string; afterState?: unknown }) => Promise<unknown>;
  actor: string;
}

export interface ApplyResult {
  familyId: string;
  rowsRevoked: number;
}

/** Revoke each family that still has unrevoked rows, then record it. Only called with --apply. */
export async function applyRevocation(deps: ApplyDeps, plans: FamilyPlan[], mode: "token" | "user", reason: string): Promise<ApplyResult[]> {
  const out: ApplyResult[] = [];
  for (const p of plans) {
    if (p.unrevoked === 0) continue;
    await deps.revokeFamily(p.familyId);
    const meta = { family_id: p.familyId, user_id: p.userId, rows_revoked: p.unrevoked, live_rows: p.live, mode, reason };
    await deps.track("security.session_family_revoked", deps.actor, "operator", meta);
    await deps.audit({
      actor: { user_id: deps.actor, role: "operator" },
      action: "auth.session_family.revoked",
      resourceType: "auth_session",
      resourceId: p.familyId,
      afterState: meta,
    });
    out.push({ familyId: p.familyId, rowsRevoked: p.unrevoked });
  }
  return out;
}

export const UNREVOKED_COUNT_SQL = `SELECT count(*)::int AS n FROM instinct_refresh_tokens WHERE family_id = $1 AND revoked_at IS NULL`;

/** After --apply: how many rows in these families are still unrevoked (want 0). */
export async function countUnrevoked(q: QueryFn, familyIds: string[]): Promise<number> {
  let left = 0;
  for (const id of familyIds) {
    const r = await q(UNREVOKED_COUNT_SQL, [id]);
    left += Number(r.rows[0]?.n ?? 0);
  }
  return left;
}
