/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";

/**
 * Ask every external credential whether it still works.
 *
 * WHY PROBING AND NOT INSPECTING. Two credentials in this system carry an
 * expiry you can read: the Qdrant key and a Vercel OIDC token, both JWTs, and
 * on 2026-09-02 both had lapsed. Everything else — the database password, the
 * Azure key, the Microsoft grant — carries no expiry at all and simply stops
 * being accepted one day. There is nothing to inspect, so the only honest
 * question is whether it works right now.
 *
 * WHAT LAPSING ACTUALLY COSTS HERE, measured on one day:
 *
 *   The Microsoft token store had been failing for a week. Interactive
 *   requests kept working, because each one refreshed in memory, so only
 *   background jobs noticed: the SharePoint sync stopped and the library
 *   repair failed every run. Neither said why.
 *
 *   The Qdrant key expired on 2026-08-31. Search still returns results, just
 *   keyword-only, and every count on every dashboard stays green. A retrieval
 *   that finds nothing by meaning is indistinguishable from one that did.
 *
 * Both were found by accident, days late, while chasing something else. That
 * is the whole argument for this file. A credential that fails loudly needs no
 * monitor; these fail by going quiet, and quiet reads as healthy.
 *
 * EVERY PROBE IS READ-ONLY and cheap: one round trip each, no writes.
 *
 * EXITS NON-ZERO when a configured credential is refused. It does NOT fail on
 * one that is absent: absent is a deployment that does not use that service,
 * and failing on it would train people to ignore the job. Absent is reported,
 * because "not configured" and "not working" are different sentences.
 *
 *   npm run check:credentials
 */

import { Client } from "pg";

type Verdict = "ok" | "refused" | "absent" | "unreachable";

interface Probe {
  name: string;
  /** What stops working when this is refused, in the reader's terms. */
  costs: string;
  run: () => Promise<{ verdict: Verdict; detail: string }>;
}

/** An expiry read out of a JWT, when the credential happens to be one. */
function jwtExpiry(value: string | undefined): Date | null {
  if (!value || value.split(".").length !== 3 || !value.startsWith("ey")) return null;
  try {
    const claims = JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString());
    return typeof claims.exp === "number" ? new Date(claims.exp * 1000) : null;
  } catch {
    return null;
  }
}

const PROBES: Probe[] = [
  {
    name: "DATABASE_URL",
    costs: "everything: this is the source of truth",
    run: async () => {
      if (!process.env.DATABASE_URL) return { verdict: "absent", detail: "not set" };
      const local = /@(localhost|127\.0\.0\.1)\b/.test(process.env.DATABASE_URL);
      const c = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: local ? false : { rejectUnauthorized: false },
      });
      try {
        await c.connect();
        await c.query("SELECT 1");
        return { verdict: "ok", detail: "connects" };
      } catch (e) {
        return { verdict: "refused", detail: (e as Error).message.slice(0, 90) };
      } finally {
        await c.end().catch(() => undefined);
      }
    },
  },
  {
    name: "QDRANT_API_KEY",
    /* The one that lapsed. Naming the consequence rather than the service,
       because "Qdrant is down" does not tell anybody what a user will see. */
    costs: "semantic search: results keep coming, keyword-only, and nothing says so",
    run: async () => {
      const url = (process.env.QDRANT_URL ?? "").replace(/\/+$/, "");
      const key = process.env.QDRANT_API_KEY;
      if (!url || !key) return { verdict: "absent", detail: "QDRANT_URL or QDRANT_API_KEY not set" };
      const expires = jwtExpiry(key);
      const expiryNote = expires
        ? ` (key expires ${expires.toISOString().slice(0, 10)})`
        : " (key carries no expiry)";
      try {
        const res = await fetch(`${url}/collections`, { headers: { "api-key": key } });
        if (res.ok) return { verdict: "ok", detail: `answers${expiryNote}` };
        return { verdict: "refused", detail: `HTTP ${res.status}${expiryNote}` };
      } catch (e) {
        return { verdict: "unreachable", detail: (e as Error).message.slice(0, 90) };
      }
    },
  },
  {
    name: "AZURE_OPENAI_API_KEY",
    costs: "embeddings, so nothing new can be indexed and no question can be asked by meaning",
    run: async () => {
      const ep = (process.env.AZURE_OPENAI_ENDPOINT ?? "").replace(/\/+$/, "");
      const dep = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT;
      const key = process.env.AZURE_OPENAI_API_KEY;
      if (!ep || !dep || !key) return { verdict: "absent", detail: "endpoint, deployment or key not set" };
      try {
        const res = await fetch(`${ep}/openai/deployments/${dep}/embeddings?api-version=2023-05-15`, {
          method: "POST",
          headers: { "api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify({ input: "credential probe" }),
        });
        if (res.ok) return { verdict: "ok", detail: `deployment ${dep} answers` };
        return { verdict: "refused", detail: `HTTP ${res.status}` };
      } catch (e) {
        return { verdict: "unreachable", detail: (e as Error).message.slice(0, 90) };
      }
    },
  },
  {
    name: "Microsoft grant",
    /* Probed through the STORED token rather than a refresh, because that is
       what every background job reads. A refresh can succeed while the write
       that keeps it fails, which is exactly what happened for a week. */
    costs: "the SharePoint sync and the library repair, both of which fail quietly",
    run: async () => {
      if (!process.env.DATABASE_URL) return { verdict: "absent", detail: "no database to read tokens from" };
      const c = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      });
      try {
        await c.connect();
        const { rows } = await c.query<{ live: string; total: string; newest: string | null }>(
          `SELECT count(*) FILTER (WHERE expires_at > now())::text AS live,
                  count(*)::text AS total,
                  max(updated_at)::text AS newest
             FROM instinct_ms_tokens`,
        );
        const r = rows[0];
        if (Number(r.total) === 0) return { verdict: "absent", detail: "nobody has connected Microsoft" };
        if (Number(r.live) === 0) {
          return { verdict: "refused", detail: `0 of ${r.total} stored tokens are live, newest write ${r.newest}` };
        }
        return { verdict: "ok", detail: `${r.live} of ${r.total} stored tokens live, newest write ${r.newest}` };
      } catch (e) {
        return { verdict: "unreachable", detail: (e as Error).message.slice(0, 90) };
      } finally {
        await c.end().catch(() => undefined);
      }
    },
  },
];

async function main(): Promise<void> {
  const results = await Promise.all(
    PROBES.map(async (p) => ({ probe: p, ...(await p.run()) })),
  );

  for (const r of results) {
    const mark =
      r.verdict === "ok" ? "ok      " : r.verdict === "absent" ? "absent  " : "REFUSED ";
    console.log(`[cred] ${mark} ${r.probe.name.padEnd(22)} ${r.detail}`);
    if (r.verdict === "refused" || r.verdict === "unreachable") {
      console.log(`[cred]          without it: ${r.probe.costs}`);
    }
  }

  const broken = results.filter((r) => r.verdict === "refused" || r.verdict === "unreachable");
  const absent = results.filter((r) => r.verdict === "absent");

  if (absent.length) {
    /* Reported, never failed on. A deployment that does not use a service is
       not broken, and a job that goes red for that gets ignored, which is how
       the two that HAD lapsed went unnoticed. */
    console.log(`\n[cred] ${absent.length} not configured here: ${absent.map((a) => a.probe.name).join(", ")}`);
  }
  if (broken.length) {
    console.error(`\n[cred] ${broken.length} configured credential(s) are being refused.`);
    process.exit(1);
  }
  console.log("\n[cred] every configured credential still works.");
}

main().catch((err) => {
  console.error("[cred] failed:", (err as Error).message);
  process.exit(1);
});
