/**
 * Do the quiet integrations WORK, or is nobody calling them?
 *
 * integration-evidence says which surfaces have produced events. It cannot say
 * why a surface is silent, and the two reasons are opposite: one nobody has
 * needed is fine and needs no work, while one that breaks when called is a
 * fault sitting behind an untested path waiting for the first client who tries
 * it. This calls each, read-only, and reports which of the two it is.
 *
 * IT LIVES HERE RATHER THAN IN THE SCRIPT because the credentials do not exist
 * on a developer machine. MS_CLIENT_ID and MS_CLIENT_SECRET are marked
 * sensitive in Vercel and come back redacted from an env pull, so a local run
 * can only ever report that it could not ask. The same logic therefore has to
 * be reachable from a server route running where the credentials are, and one
 * implementation serving both is the only way the CLI and the route cannot
 * drift into two different answers.
 *
 * IT REFUSES TO GUESS. The first version of this reported three surfaces
 * "genuinely broken" and two "working" without touching Microsoft: every
 * failure was one missing credential, every success was a Postgres cache read,
 * and one "crash" was its own summarizer. A diagnostic that reports findings
 * it did not observe is worse than none, because somebody acts on it.
 *
 * READ-ONLY BY CONSTRUCTION. Every entry point is a list or a get. Nothing
 * here creates, updates, sends or deletes, because a diagnostic that writes to
 * somebody's mailbox to prove it can is not a diagnostic.
 */

export type ProbeVerdict =
  /** A live Graph call returned data. */
  | "works"
  /** A live Graph call succeeded and there was nothing to return. */
  | "empty"
  /** Answered from the local cache. Says nothing about Graph either way. */
  | "cache"
  /** Graph refused for want of a consent. Not a code defect. */
  | "scope_missing"
  /** The call genuinely failed. */
  | "failed";

export interface ProbeResult {
  label: string;
  verdict: ProbeVerdict;
  detail: string;
}

/**
 * Read a probe outcome without pretending an empty list is a failure.
 *
 * An account with no OneNote notebooks returns []. That is the integration
 * working perfectly and having nothing to say, and calling it broken would
 * send somebody to debug a healthy path. Distinguished from a thrown error,
 * which is the surface genuinely not working.
 */
export function classify(value: unknown): ProbeVerdict {
  if (value === null || value === undefined) return "empty";
  if (Array.isArray(value)) return value.length > 0 ? "works" : "empty";
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    /* The repo's typed-Result shape: { ok: false, error: { kind } }. */
    if (o.ok === false) {
      /* Two error shapes in this repo: { error: { kind } } and { code }.
         Reading only the first is what made a correctly-typed Planner refusal
         look like a crash in the first version of this file. */
      const kind = String(
        (o.error as Record<string, unknown>)?.kind ?? o.code ?? "error",
      );
      return /scope|consent|forbidden/i.test(kind) ? "scope_missing" : "failed";
    }
    for (const k of ["contacts", "users", "groups", "notebooks", "value", "data"]) {
      if (Array.isArray(o[k])) return (o[k] as unknown[]).length > 0 ? "works" : "empty";
    }
    return "works";
  }
  return "works";
}

function reason(err: unknown): ProbeVerdict {
  const m = (err as Error)?.message ?? "";
  /* Graph answers a missing consent with 403 and a scope name. That is not a
     broken integration, it is an ungranted permission, and the fix is a
     consent rather than a code change. */
  if (/403|scope|consent|forbidden/i.test(m)) return "scope_missing";
  return "failed";
}

/**
 * Surfaces that answer from the Postgres cache rather than from Graph.
 *
 * Their read path is a SQL query, so a result proves the cache has rows and
 * nothing about whether the integration can still reach Microsoft. Naming them
 * here keeps a cache hit from being read as a live integration, which is
 * exactly the mistake the first run of this script made.
 */
const CACHE_BACKED = new Set(["Directory", "Groups", "Contacts"]);

export async function probeAll(userId: string): Promise<ProbeResult[]> {
  const probes: { label: string; run: () => Promise<unknown> }[] = [
    { label: "People", run: async () => (await import("./microsoft-people")).suggestPeople(userId, undefined, 5) },
    { label: "Contacts", run: async () => (await import("./microsoft-contacts")).listContacts(userId, { limit: 5 }) },
    { label: "Mailbox settings", run: async () => (await import("./microsoft-mailbox")).getOwnMailboxSettings(userId) },
    { label: "OneNote", run: async () => (await import("./microsoft-onenote")).listNotebooks(userId) },
    { label: "Presence", run: async () => (await import("./microsoft-presence")).getOwnPresence(userId) },
    { label: "Directory", run: async () => (await import("./microsoft-directory")).listUsers(userId, { top: 5 }) },
    { label: "Planner", run: async () => (await import("./microsoft-planner")).listRosterPlans(userId) },
    { label: "Groups", run: async () => (await import("./microsoft-groups")).listMyGroups(userId, { limit: 5 }) },
  ];

  const out: ProbeResult[] = [];
  for (const p of probes) {
    try {
      const v = await p.run();
      const verdict = CACHE_BACKED.has(p.label) ? "cache" : classify(v);
      out.push({ label: p.label, verdict, detail: summarize(v) });
    } catch (err) {
      out.push({ label: p.label, verdict: reason(err), detail: (err as Error).message.slice(0, 90) });
    }
  }
  return out;
}

function summarize(v: unknown): string {
  if (v === null || v === undefined) return "returned nothing";
  if (Array.isArray(v)) return `${v.length} item(s)`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of ["contacts", "users", "groups", "value", "data"]) {
      if (Array.isArray(o[k])) return `${(o[k] as unknown[]).length} ${k}`;
    }
    if (o.ok === false) {
      return `error: ${String(JSON.stringify(o.error ?? o.code ?? o.message ?? o)).slice(0, 70)}`;
    }
    return "returned an object";
  }
  return String(v).slice(0, 60);
}
