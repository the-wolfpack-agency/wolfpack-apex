/**
 * Live DB adapter for the learned-signature loop. Kept out of learned-signatures.ts
 * so the pure mine/match core stays I/O-free and unit-testable. Reuses getOperators
 * (the same dossiers the board shows) as the corpus and autoBlockOperator (the same
 * distributed block rail the honeytoken flywheel uses) for enforcement.
 */
import { query } from "@/lib/db";
import { trackEvent, type InstinctEventType } from "@/lib/analytics";
import { getOperators } from "@/lib/agent-operators";
import { autoBlockOperator } from "@/lib/forcefield/blocked-fingerprints";
import type { LearnedSignatureDeps, MinedSignature, OperatorDossierLite, StoredSignature } from "@/lib/forcefield/learned-signatures";

const LOOKBACK_DAYS = 30;

/** An operator is treated as known-good (a false-positive if matched) when it is
 *  an identified/rule-respecting crawler or presents a verified principal. */
function isWelcomed(behaviorClasses: string[], tells: string[]): boolean {
  return behaviorClasses.includes("benign_crawler") || tells.includes("identified_agent") || tells.includes("principal_verified");
}

export function liveLearnedSignatureDeps(): LearnedSignatureDeps {
  const workspaceId = process.env.FORCEFIELD_EDGE_WORKSPACE_ID || "default";
  return {
    listDossiers: async (): Promise<OperatorDossierLite[]> => {
      const ops = await getOperators(workspaceId, LOOKBACK_DAYS);
      return ops.map((o) => ({
        operatorKey: o.operatorKey,
        threatLevel: o.threatLevel,
        welcomed: isWelcomed(o.behaviorClasses, o.tells),
        tells: o.tells,
      }));
    },
    upsertSignature: async (sig: MinedSignature) => {
      await query(
        `INSERT INTO instinct_learned_hostile_signatures (sig_hash, workspace_id, tells, dangerous, prevalence, last_evaluated)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (sig_hash) DO UPDATE
           SET prevalence = GREATEST(instinct_learned_hostile_signatures.prevalence, EXCLUDED.prevalence),
               dangerous = EXCLUDED.dangerous,
               last_evaluated = now()`,
        [sig.sigHash, workspaceId, sig.tells, sig.dangerous, sig.prevalence],
      );
    },
    listSignatures: async (): Promise<StoredSignature[]> => {
      const { rows } = await query<{ sig_hash: string; tells: string[]; dangerous: boolean; prevalence: number; status: string; shadow_matches: number; false_positive_hits: number }>(
        `SELECT sig_hash, tells, dangerous, prevalence, status, shadow_matches, false_positive_hits
           FROM instinct_learned_hostile_signatures
          WHERE workspace_id = $1 AND status <> 'retired'`,
        [workspaceId],
      );
      return rows.map((r) => ({
        sigHash: r.sig_hash,
        tells: Array.isArray(r.tells) ? r.tells : [],
        dangerous: r.dangerous,
        prevalence: Number(r.prevalence),
        status: r.status as StoredSignature["status"],
        shadowMatches: Number(r.shadow_matches),
        falsePositiveHits: Number(r.false_positive_hits),
      }));
    },
    recordShadowMatch: async (sigHash: string) => {
      await query(
        `UPDATE instinct_learned_hostile_signatures SET shadow_matches = shadow_matches + 1
          WHERE sig_hash = $1 AND workspace_id = $2 AND status = 'shadow'`,
        [sigHash, workspaceId],
      );
    },
    recordFalsePositive: async (sigHash: string) => {
      await query(
        `UPDATE instinct_learned_hostile_signatures SET false_positive_hits = false_positive_hits + 1
          WHERE sig_hash = $1 AND workspace_id = $2`,
        [sigHash, workspaceId],
      );
    },
    promoteSignature: async (sigHash: string) => {
      await query(
        `UPDATE instinct_learned_hostile_signatures SET status = 'enforcing', promoted_at = now()
          WHERE sig_hash = $1 AND workspace_id = $2 AND status = 'shadow'`,
        [sigHash, workspaceId],
      );
    },
    autoBlockOperator: async (operatorKey: string, reason: string): Promise<number> => {
      const n = await autoBlockOperator(operatorKey, reason);
      if (n > 0) {
        const prefix = reason.replace(/^learned:/, "");
        await query(
          `UPDATE instinct_learned_hostile_signatures SET auto_blocked = auto_blocked + 1
            WHERE workspace_id = $2 AND sig_hash LIKE $1 || '%'`,
          [prefix, workspaceId],
        ).catch(() => {});
      }
      return n;
    },
    track: (event: InstinctEventType, payload: Record<string, string | number | boolean>) => {
      trackEvent(event, "system", "forcefield", payload);
    },
  };
}
