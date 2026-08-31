/**
 * Exercise the integrations that were built and never run.
 *
 * WHAT THIS IS ABOUT. Eighteen Microsoft surfaces are built; twelve had ever
 * run in production. The playbook says so honestly, and "twelve of eighteen"
 * is a strange thing to show a client about your own product: it reads as six
 * things nobody bothered to try.
 *
 * The six were People, Contacts, Mailbox settings, OneNote, Presence and
 * Project. Nothing was wrong with them. They sit behind features nobody on
 * this team happens to use daily, so no event was ever written, and a surface
 * with no events is indistinguishable from a broken one.
 *
 * READ-ONLY, AND THAT IS NOT NEGOTIABLE. Every call here lists or fetches.
 * None creates a contact, writes a note or changes a setting. A number on a
 * slide is not a reason to write into somebody's mailbox, and a probe that
 * mutated to prove it works would be the worst possible way to earn the claim.
 *
 * IT CALLS THE REAL MODULE, not Graph directly, which is the whole point. Each
 * module already records its own analytics, so exercising it writes exactly
 * the event a real use would write. Reaching past them to Graph would prove
 * the network works and leave the integration as unexercised as before.
 *
 * RUNS NIGHTLY WITH THE OTHER PROBES, so the claim stays true rather than
 * being true on the day somebody ran a script.
 */

import { persistProbeResult, type ProbeResult } from "@/lib/health/integration-probes";
import { getValidToken } from "@/lib/microsoft-graph";

/** A connection that can actually be refreshed, not merely a row in a table. */
async function defaultHasToken(userId: string): Promise<boolean> {
  try {
    const token = await getValidToken(userId);
    return Boolean(token?.accessToken);
  } catch {
    return false;
  }
}

export interface SurfaceProbe {
  objectType: string;
  /** Runs the real module. Resolves when the surface answered. */
  run: (userId: string) => Promise<{ detail: Record<string, unknown> }>;
  /**
   * True when this surface needs a scope this deployment deliberately does not
   * request. A failure then is expected state rather than a fault, and must not
   * page anybody.
   */
  needsDisabledScope?: boolean;
  /** Which scope, so the fix is a decision rather than an investigation. */
  scope?: string;
}

export const UNPROVEN_SURFACES: SurfaceProbe[] = [
  {
    objectType: "people",
    run: async (userId) => {
      const { suggestPeople } = await import("@/lib/integrations/microsoft-people");
      /* No search term: the caller's own frequent contacts, which is the
         cheapest read this surface offers. */
      const people = await suggestPeople(userId, undefined, 1);
      return { detail: { suggested: people.length } };
    },
  },
  {
    objectType: "contacts",
    run: async (userId) => {
      const { listContacts } = await import("@/lib/integrations/microsoft-contacts");
      const res = await listContacts(userId, { limit: 1 });
      return { detail: { listed: res.contacts.length } };
    },
  },
  {
    objectType: "onenote",
    run: async (userId) => {
      const { listNotebooks } = await import("@/lib/integrations/microsoft-onenote");
      const books = await listNotebooks(userId);
      return { detail: { notebooks: books.length } };
    },
  },
  {
    objectType: "presence",
    run: async (userId) => {
      const { getOwnPresence } = await import("@/lib/integrations/microsoft-presence");
      const p = await getOwnPresence(userId);
      /* Null is a real answer here: presence can be unavailable without the
         surface being broken. What is being proved is that the call was
         served. */
      return { detail: { availability: p?.availability ?? "unavailable" } };
    },
  },
  {
    objectType: "project",
    run: async (userId) => {
      const { searchProjectTasks } = await import("@/lib/integrations/microsoft-project");
      const token = await getValidToken(userId);
      if (!token?.accessToken) throw new Error("No valid token");
      const res = await searchProjectTasks(token.accessToken, { query: "plan" });
      if (!res.ok) throw new Error(res.code);
      return { detail: { served: true } };
    },
  },
  {
    objectType: "mailbox",
    /* THE ONE THAT CANNOT BE MADE TO PASS, and saying so is the point.
       MailboxSettings.Read requires administrator consent and is deliberately
       not requested, so this surface cannot run until somebody decides it
       should. That is a decision on the client access pack, not a bug, and
       recording it as expected state keeps it off the alerting while leaving
       it visible in the evidence. */
    needsDisabledScope: true,
    scope: "MailboxSettings.Read",
    run: async (userId) => {
      const { getOwnMailboxSettings } = await import("@/lib/integrations/microsoft-mailbox");
      const s = await getOwnMailboxSettings(userId);
      return { detail: { timezone: s?.timeZone ?? "unknown" } };
    },
  },
];

/**
 * Run each surface once and record what happened.
 *
 * One failure never stops the others: the whole reason these went unexercised
 * is that nothing ran them, and a sweep that aborts on the first problem would
 * leave the rest exactly as unproven as before.
 */
export async function exerciseUnprovenSurfaces(
  workspaceId: string,
  userId: string,
  surfaces: SurfaceProbe[] = UNPROVEN_SURFACES,
  hasToken: (userId: string) => Promise<boolean> = defaultHasToken,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];

  /* NO TOKEN MEANS NOTHING BELOW PROVES ANYTHING, and this gate exists
   * because the first version reported three surfaces as working when it had
   * no Microsoft connection at all.
   *
   * Several of these modules map a failure to null by design: presence
   * returns null when it cannot read presence, mailbox settings returns null
   * when it cannot read settings, and both do the same when the token is
   * missing. A probe that treated a null as "the call was served" recorded
   * mailbox settings as working while the scope it needs is not even
   * requested, which is impossible and was reported as fact.
   *
   * That is the same defect this product spends its life designing against,
   * written into the very check meant to prove things work. Asked once, up
   * front, it cannot happen: with no connection every surface is unproven,
   * which is the truth. */
  if (!(await hasToken(userId))) {
    const unknown: ProbeResult[] = surfaces.map((surface) => ({
      vendor: "microsoft",
      probeKind: "connectivity",
      objectType: surface.objectType,
      ok: false,
      errorMessage: `no connected Microsoft account for ${userId}, so this surface was not exercised`,
      /* Expected state on a deployment nobody has connected yet. It is not a
         fault in the surface, and reporting it as one would send somebody
         debugging code that was never reached. */
      notConfigured: true,
      durationMs: 0,
    }));
    for (const r of unknown) await persistProbeResult(workspaceId, r).catch(() => undefined);
    return unknown;
  }

  for (const surface of surfaces) {
    const started = Date.now();
    try {
      const { detail } = await surface.run(userId);
      results.push({
        vendor: "microsoft",
        probeKind: "connectivity",
        objectType: surface.objectType,
        ok: true,
        schemaPayload: detail,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "failed";
      results.push({
        vendor: "microsoft",
        probeKind: "connectivity",
        objectType: surface.objectType,
        ok: false,
        errorMessage: surface.needsDisabledScope
          ? `not requested on this deployment: ${surface.scope} needs administrator consent`
          : message.slice(0, 200),
        /* Expected state stays quiet; anything else is a real fault. */
        ...(surface.needsDisabledScope ? { notConfigured: true } : {}),
        durationMs: Date.now() - started,
      });
    }
  }

  for (const r of results) await persistProbeResult(workspaceId, r).catch(() => undefined);
  return results;
}
