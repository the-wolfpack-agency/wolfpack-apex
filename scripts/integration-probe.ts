/**
 * Do the quiet integrations WORK, or is nobody calling them?
 *
 * integration-evidence.ts says which surfaces have produced events. It cannot
 * say why a surface is silent, and the two reasons are opposite: a surface
 * nobody has needed is fine and needs no work, while a surface that breaks
 * when called is a defect sitting behind an untested path waiting for the
 * first client who tries it.
 *
 * "Stale" and "unproven" are statements about USAGE. Reading them as "broken"
 * would send somebody building UI for OneNote because a report had a zero in
 * it, which is inventing work; reading them as "fine" leaves a real fault
 * undiscovered. So this calls each one once, read-only, with a real token, and
 * reports which of the two it is.
 *
 *   npx tsx scripts/integration-probe.ts
 *   npx tsx scripts/integration-probe.ts --user <connected_by>
 *
 * READ-ONLY BY CONSTRUCTION. Every entry point below is a list or a get. No
 * probe creates, updates, sends or deletes anything, because a diagnostic that
 * writes to somebody's mailbox to prove it can is not a diagnostic.
 *
 * IT REFUSES TO GUESS, and that rule was written after the first version of
 * this file lied. Run without Graph credentials, every stored token was
 * expired, MS_CLIENT_ID and MS_CLIENT_SECRET were unset so none could be
 * refreshed, and getValidToken returned null for everybody. The probe printed
 * a confident table anyway: three surfaces "genuinely broken", two "working".
 * Not one of those verdicts touched Microsoft. The failures were the missing
 * local credential, the successes were reads from the Postgres cache, and one
 * "crash" was this file's own summarizer.
 *
 * A diagnostic that reports findings it did not observe is worse than no
 * diagnostic, because somebody acts on it. So this now establishes a live
 * token FIRST and stops with nothing if it cannot, and a surface answered from
 * cache is reported as cache rather than as proof the integration works.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

/* Dynamic imports throughout: a static one is hoisted above config() and the
   pool is then built without a connection string. See scripts/brain-eval.ts. */

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
    { label: "People", run: async () => (await import("../src/lib/integrations/microsoft-people")).suggestPeople(userId, undefined, 5) },
    { label: "Contacts", run: async () => (await import("../src/lib/integrations/microsoft-contacts")).listContacts(userId, { limit: 5 }) },
    { label: "Mailbox settings", run: async () => (await import("../src/lib/integrations/microsoft-mailbox")).getOwnMailboxSettings(userId) },
    { label: "OneNote", run: async () => (await import("../src/lib/integrations/microsoft-onenote")).listNotebooks(userId) },
    { label: "Presence", run: async () => (await import("../src/lib/integrations/microsoft-presence")).getOwnPresence(userId) },
    { label: "Directory", run: async () => (await import("../src/lib/integrations/microsoft-directory")).listUsers(userId, { top: 5 }) },
    { label: "Planner", run: async () => (await import("../src/lib/integrations/microsoft-planner")).listRosterPlans(userId) },
    { label: "Groups", run: async () => (await import("../src/lib/integrations/microsoft-groups")).listMyGroups(userId, { limit: 5 }) },
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

async function main() {
  const i = process.argv.indexOf("--user");
  let userId = i >= 0 ? process.argv[i + 1] : "";

  if (!userId) {
    const { query } = await import("../src/lib/db");
    const { rows } = await query<{ connected_by: string }>(
      `SELECT connected_by FROM instinct_ms_tokens ORDER BY updated_at DESC LIMIT 1`,
    );
    userId = rows[0]?.connected_by ?? "";
  }
  if (!userId) {
    console.error("No connected Microsoft account. Pass --user <connected_by>.");
    process.exit(1);
  }

  /* THE CHECK THAT MAKES THE REST MEAN ANYTHING. Without a live token every
     Graph call fails identically for a reason that has nothing to do with the
     integration, and the table below would report that as breakage. Stop with
     nothing rather than produce findings nobody could act on correctly. */
  const { getValidToken } = await import("../src/lib/microsoft-graph");
  const token = await getValidToken(userId);
  if (!token) {
    console.error(
      [
        "",
        "Cannot probe: no live Microsoft token for this account.",
        "",
        "  Every Graph call would fail for that one reason, and a table of",
        "  failures would read as broken integrations. Nothing is reported.",
        "",
        "  Usual causes: the stored token has expired and MS_CLIENT_ID /",
        "  MS_CLIENT_SECRET are absent here, so it cannot be refreshed.",
        "  Run where those are set, or reconnect the account first.",
        "",
      ].join("\n"),
    );
    process.exit(2);
  }

  const results = await probeAll(userId);
  console.log("\nIntegration probe (read-only)\n");
  console.log("  surface              verdict         detail");
  console.log("  " + "-".repeat(64));
  for (const r of results) {
    console.log(`  ${r.label.padEnd(20)} ${r.verdict.padEnd(15)} ${r.detail}`);
  }
  const broken = results.filter((r) => r.verdict === "failed");
  const scopes = results.filter((r) => r.verdict === "scope_missing");
  const cached = results.filter((r) => r.verdict === "cache");
  console.log(
    `\n  ${broken.length} genuinely broken, ${scopes.length} awaiting a consent, ` +
      `${results.length - broken.length - scopes.length - cached.length} reached Graph, ` +
      `${cached.length} answered from cache and were not proved either way.\n`,
  );
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error("[integration-probe]", (err as Error).message);
      process.exit(1);
    },
  );
}
