/**
 * Report a sign-in attempt that used a canary login: the canary trip (event +
 * audit + alert, canary-store.ts), a decoy-trip site event carrying the canary's
 * ORIGIN (which site, decoy and session it was planted in), and the client's
 * fingerprint auto-blocked. One function, used by the public check endpoint
 * (other sites) and by Instinct's own sign-in. Never throws.
 */
import { CANARY_LOGIN_RE, findCanaryLogin, type CanaryQuery } from "@/lib/forcefield/canary-login";
import { recordCanaryTrip } from "@/lib/forcefield/canary-store";
import { recordSiteEvent } from "@/lib/site-analytics";
import { autoBlockFingerprint } from "@/lib/forcefield/blocked-fingerprints";

export interface CanarySignInAttempt { site: string; username: string; path?: string; fp?: string; sig?: string }

export interface CanaryTripEffects {
  find: typeof findCanaryLogin;
  trip: typeof recordCanaryTrip;
  event: typeof recordSiteEvent;
  block: typeof autoBlockFingerprint;
}
const live: CanaryTripEffects = { find: findCanaryLogin, trip: recordCanaryTrip, event: recordSiteEvent, block: autoBlockFingerprint };

/** True when the username is a planted canary (and the trip was recorded). */
export async function reportCanarySignIn(a: CanarySignInAttempt, fx: CanaryTripEffects = live, q?: CanaryQuery): Promise<boolean> {
  try {
    if (!CANARY_LOGIN_RE.test(a.username)) return false;
    const hit = await (q ? fx.find(a.username, q) : fx.find(a.username));
    if (!hit) return false;
    const path = (a.path || "/login").slice(0, 256);
    await fx.trip({
      workspaceId: hit.workspaceId,
      action: { workspaceId: hit.workspaceId, agentId: `site:${a.site}`, kind: "inbound_request", url: path, payload: a.username },
      hits: [{ canaryId: hit.id, kind: "login", seededIn: hit.seededIn, surface: "payload", reason: "canary sign-in credential used (payload, inbound_request)" }],
      site: a.site,
    }).catch(() => undefined);
    await fx.event({
      eventType: "site.agent_trap_tripped",
      path,
      props: {
        site: a.site,
        reason: "canary_login",
        reason_kind: "honeytoken",
        canary: true,
        ...(hit.origin ? { canary_origin_site: hit.origin.site, canary_origin_decoy: hit.origin.decoy, canary_origin_sig: hit.origin.sig } : {}),
        ...(a.fp ? { fp: a.fp.slice(0, 80) } : {}),
        ...(a.sig ? { sig: a.sig.slice(0, 32) } : {}),
      },
    }).catch(() => undefined);
    if (a.fp) await fx.block(a.fp, "honeytoken").catch(() => 0);
    return true;
  } catch {
    return false;
  }
}
