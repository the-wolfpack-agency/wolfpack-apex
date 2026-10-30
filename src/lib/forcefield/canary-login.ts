/**
 * Canary logins: fake service sign-ins planted only where no person ever looks
 * (the decoy maze, decoy responses to probes for config and backup files). Using
 * one at a sign-in form is proof that someone harvested it and replayed it, and
 * the canary itself records WHERE it was planted and to WHICH session, so the
 * earlier scanner and the later sign-in attempt are linked even after the
 * attacker changes IP address and tools.
 *
 * Stored as kind "login" in instinct_forcefield_canaries (the existing canary
 * registry, so the trip goes through the same event + audit + alert path):
 *   value       the username, e.g. "svc_backup_k7q2m4" (CANARY_LOGIN_RE)
 *   seeded_in   "login:site=<label>;decoy=<path>;sig=<session sig>", the origin;
 *               unique per workspace, so minting is idempotent per decoy and
 *               session (the maze's heavy traffic adds a handful of rows, not one
 *               per page view)
 * The password is derived from the canary id with a server key, so it is stable
 * for the same canary and never stored.
 *
 * Precision: a real person cannot type a 17-character random service username by
 * chance, and a sign-in check only sends usernames of this exact shape. Nothing
 * here can lock out or affect a real account.
 */
import { createHmac, randomBytes, randomInt } from "node:crypto";
import { query, safeQuery } from "@/lib/db";

// The canary username shape lives in the vendored engine (one definition, the
// one sites match against).
import { CANARY_LOGIN_RE } from "@/lib/forcefield-web/canary-signin";
export { CANARY_LOGIN_RE };
const WORDS = ["backup", "deploy", "sync", "export", "reports", "monitor", "billing", "ops"] as const;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** The workspace site canaries live under (the same one the edge ruleset uses). */
export const SITE_CANARY_WORKSPACE = process.env.FORCEFIELD_EDGE_WORKSPACE_ID || "default";

export function newCanaryUsername(): string {
  let tail = "";
  for (let i = 0; i < 6; i++) tail += B32[randomInt(B32.length)];
  return `svc_${WORDS[randomInt(WORDS.length)]}_${tail}`;
}

// Without the server key the passwords come from a random key made at start-up:
// they stay unguessable, and only lose stability across instances (a fake
// password, so nothing depends on that). Never a fixed string.
const PROCESS_KEY = randomBytes(32);

/** The canary's password: stable per canary, derived with a server key, never stored. */
export function canaryPassword(canaryId: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = env.INSTINCT_SECRET_KEY || PROCESS_KEY;
  return createHmac("sha256", key).update(`canary-login:${canaryId}`).digest("base64url").slice(0, 20);
}

export interface CanaryOrigin { site: string; decoy: string; sig: string }
const clean = (s: string, n: number) => String(s ?? "").replace(/[;=\s]/g, "").slice(0, n);

/** The seeded_in key for an origin (pure). */
export function seedKey(o: CanaryOrigin): string {
  return `login:site=${clean(o.site, 64)};decoy=${clean(o.decoy, 120)};sig=${clean(o.sig, 32)}`;
}

/** Read an origin back from seeded_in (pure); null for anything else. */
export function parseSeed(seededIn: string): CanaryOrigin | null {
  if (!seededIn.startsWith("login:")) return null;
  const f = Object.fromEntries(seededIn.slice(6).split(";").map((kv) => kv.split("=") as [string, string]));
  return typeof f.site === "string" && typeof f.decoy === "string" ? { site: f.site, decoy: f.decoy, sig: f.sig ?? "" } : null;
}

export type CanaryQuery = (text: string, params: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
const appWrite: CanaryQuery = (t, p) => query(t, p) as never;
const appRead: CanaryQuery = (t, p) => safeQuery(t, p) as never;

/** The canary for an origin, created the first time (idempotent). Null on a store error. */
export async function mintCanaryLogin(
  origin: CanaryOrigin,
  opts: { workspaceId?: string; q?: CanaryQuery; env?: NodeJS.ProcessEnv; username?: () => string } = {},
): Promise<{ username: string; password: string } | null> {
  const q = opts.q ?? appWrite;
  const ws = opts.workspaceId ?? SITE_CANARY_WORKSPACE;
  const seed = seedKey(origin);
  try {
    await q(
      `INSERT INTO instinct_forcefield_canaries (workspace_id, kind, value, seeded_in, created_by)
       VALUES ($1, 'login', $2, $3, 'forcefield')
       ON CONFLICT (workspace_id, seeded_in) WHERE kind = 'login' DO NOTHING`,
      [ws, (opts.username ?? newCanaryUsername)(), seed],
    );
    const { rows } = await q(
      "SELECT id::text AS id, value FROM instinct_forcefield_canaries WHERE workspace_id = $1 AND kind = 'login' AND seeded_in = $2 AND active",
      [ws, seed],
    );
    const r = rows[0] as { id: string; value: string } | undefined;
    return r ? { username: r.value, password: canaryPassword(r.id, opts.env) } : null;
  } catch {
    return null;
  }
}

export interface FoundCanary { id: string; workspaceId: string; username: string; seededIn: string; origin: CanaryOrigin | null }

/** The active login canary with this exact username, or null (also null for
 *  anything not shaped like one, without a query). */
export async function findCanaryLogin(username: string, q: CanaryQuery = appRead): Promise<FoundCanary | null> {
  if (!CANARY_LOGIN_RE.test(username)) return null;
  try {
    const { rows } = await q(
      "SELECT id::text AS id, workspace_id, value, seeded_in FROM instinct_forcefield_canaries WHERE kind = 'login' AND value = $1 AND active LIMIT 1",
      [username],
    );
    const r = rows[0] as { id: string; workspace_id: string; value: string; seeded_in: string } | undefined;
    return r ? { id: r.id, workspaceId: r.workspace_id, username: r.value, seededIn: r.seeded_in, origin: parseSeed(r.seeded_in) } : null;
  } catch {
    return null;
  }
}
