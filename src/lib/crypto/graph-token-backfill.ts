/**
 * graph-token-backfill.ts - pure planning logic for re-sealing legacy plaintext
 * Microsoft Graph tokens (the operator script scripts/encrypt-graph-tokens.ts
 * does the IO; this file decides, so the decision is unit-tested).
 *
 * The app already re-seals a legacy row the first time it is read
 * (getValidToken). This exists for rows nobody reads, so "every row is sealed"
 * can be made true on purpose rather than eventually.
 *
 * KEY CHECK FIRST. A backfill run from a shell whose key differs from the
 * app's would seal every token under the wrong key, and the app would then be
 * unable to open any of them. `vercel env pull` redacts sensitive values, so
 * this is the likely failure, not a theoretical one. checkKey refuses to plan
 * any write unless at least one value the app ALREADY sealed opens with the
 * key in this environment.
 */

import { isSealedToken, openGraphToken, sealGraphToken } from "@/lib/crypto/graph-token-storage";

export interface StoredTokenRow {
  connected_by: string;
  user_email: string;
  access_token: string;
  refresh_token: string;
}

export interface PlannedUpdate {
  connected_by: string;
  user_email: string;
  /** The values currently stored, used as the optimistic-concurrency guard. */
  prev_access_token: string;
  prev_refresh_token: string;
  sealed_access_token: string;
  sealed_refresh_token: string;
}

export interface BackfillPlan {
  total: number;
  alreadySealed: number;
  unreadable: string[];
  updates: PlannedUpdate[];
}

export type KeyCheck =
  | { ok: true; verifiedAgainst: number }
  | { ok: false; reason: "no_key_configured" | "redacted_key" | "no_sealed_sample" | "key_mismatch" };

/**
 * Is the key in THIS environment the app's key? `samples` are values the app
 * sealed (connector credentials, already-sealed Graph tokens).
 */
export function checkKey(env: NodeJS.ProcessEnv, samples: string[]): KeyCheck {
  const raw = env.INSTINCT_SECRET_KEY || env.INSTINCT_JWT_SECRET || "";
  if (raw.length < 32) return { ok: false, reason: "no_key_configured" };
  if (/SENSITIVE|REDACTED/i.test(raw)) return { ok: false, reason: "redacted_key" };
  const sealed = samples.filter((s) => isSealedToken(s));
  if (sealed.length === 0) return { ok: false, reason: "no_sealed_sample" };
  for (const s of sealed) {
    const opened = openGraphToken(s);
    if (!opened.ok) return { ok: false, reason: "key_mismatch" };
  }
  return { ok: true, verifiedAgainst: sealed.length };
}

/** Plan the rewrite. Never includes a row whose tokens are already sealed. */
export function planBackfill(rows: StoredTokenRow[]): BackfillPlan {
  const plan: BackfillPlan = { total: rows.length, alreadySealed: 0, unreadable: [], updates: [] };
  for (const row of rows) {
    const a = openGraphToken(row.access_token);
    const r = openGraphToken(row.refresh_token);
    if (!a.ok || !r.ok || a.value === null || r.value === null) {
      plan.unreadable.push(row.connected_by);
      continue;
    }
    if (a.format === "sealed" && r.format === "sealed") {
      plan.alreadySealed++;
      continue;
    }
    plan.updates.push({
      connected_by: row.connected_by,
      user_email: row.user_email,
      prev_access_token: row.access_token,
      prev_refresh_token: row.refresh_token,
      sealed_access_token: a.format === "sealed" ? row.access_token : sealGraphToken(a.value),
      sealed_refresh_token: r.format === "sealed" ? row.refresh_token : sealGraphToken(r.value),
    });
  }
  return plan;
}
