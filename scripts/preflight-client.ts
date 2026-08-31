/**
 * Can this deployment be handed to a client today?
 *
 * Everything I verified today was verified against our own instance, which has
 * had documents, connectors and a months-old account for as long as anybody has
 * looked at it. A fresh client deployment has none of those, and the failures it
 * hits are exactly the ones our instance stopped showing long ago.
 *
 * This runs the checks in the order they block each other and prints what to do
 * next. It answers one question and refuses to guess at it: an instance where a
 * check could not run is reported unknown, never ok.
 *
 * Usage:
 *   PROD_URL=https://client.vercel.app npx tsx scripts/preflight-client.ts
 */
import { query } from "@/lib/db";
import { isEmbeddingConfigured } from "@/lib/brain/embedder";
import {
  assessPreflight,
  describePreflight,
  type Check,
} from "@/lib/deployment/preflight";

const BASE = (process.env.PROD_URL ?? "https://wolfpack-instinct.vercel.app").replace(/\/$/, "");

async function safely<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/* Exported so the Phase 1 readiness command can ask the same questions rather
   than asking slightly different ones. Two commands that disagree about
   whether a deployment is ready is worse than either alone. */
export async function gather(): Promise<Check[]> {
  const checks: Check[] = [];

  /* 1. The deployment is answering at all. Everything else is measured through
        it, so a wrong answer here makes every later check meaningless rather
        than merely failing. */
  const version = await safely(async () => {
    const res = await fetch(`${BASE}/api/version`, { signal: AbortSignal.timeout(15_000) });
    return res.ok ? ((await res.json()) as { sha?: string; env?: string }) : null;
  });
  checks.push({
    id: "deployed",
    proves: "the deployment is serving",
    state: version?.sha ? "ok" : "broken",
    detail: version?.sha ? `serving ${version.sha.slice(0, 12)}` : `no answer from ${BASE}`,
    blocks: ["auth", "corpus", "embeddings", "connectors"],
  });

  /* 2. Somebody can sign in. A deployment nobody can enter is not a deployment,
        and this is the check a client performs first without being asked. */
  const login = await safely(async () => {
    const res = await fetch(`${BASE}/login`, { signal: AbortSignal.timeout(15_000) });
    return res.status;
  });
  checks.push({
    id: "auth",
    proves: "the sign-in page loads",
    state: login === 200 ? "ok" : login === null ? "unknown" : "broken",
    detail: login === 200 ? "200" : `got ${login ?? "no response"}`,
    blocks: [],
  });

  /* 3. Documents. EMPTY IS NOT BROKEN: a new instance with nothing ingested is
        working correctly and cannot be demonstrated, which are different
        problems with different fixes and look identical in a pass column. */
  const corpus = await safely(async () => {
    const r = await query<{ docs: string; chunks: string }>(
      `SELECT (SELECT count(*) FROM brain_documents WHERE status = 'indexed')::text AS docs,
              (SELECT count(*) FROM brain_chunks)::text AS chunks`,
    );
    return r.rows[0] ?? null;
  });
  const docs = Number(corpus?.docs ?? 0);
  checks.push({
    id: "corpus",
    proves: "documents are indexed",
    state: corpus === null ? "unknown" : docs > 0 ? "ok" : "needs_setup",
    detail:
      corpus === null
        ? "could not read the database"
        : docs > 0
          ? `${docs} documents, ${corpus?.chunks} chunks`
          : "no documents yet: connect SharePoint or upload one",
    blocks: ["retrieval"],
  });

  /* 4. Semantic retrieval. Without it the product answers only when somebody
        uses the document's own words, which is the failure a client meets on
        their first paraphrase. */
  checks.push({
    id: "embeddings",
    proves: "semantic search is available",
    state: isEmbeddingConfigured() ? "ok" : "needs_setup",
    detail: isEmbeddingConfigured()
      ? "embedding deployment configured"
      : "no embedding deployment: only exact wording will match",
    blocks: ["retrieval"],
  });

  /* 5. Retrieval actually returns something. Distinct from the corpus check:
        documents can be indexed and still unreachable, which is precisely what
        happened here for most of today. */
  const retrieval = await safely(async () => {
    const r = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM brain_query_log
        WHERE created_at > now() - interval '7 days' AND hit_count > 0`,
    );
    return Number(r.rows[0]?.n ?? 0);
  });
  checks.push({
    id: "retrieval",
    proves: "retrieval has returned results",
    state: retrieval === null ? "unknown" : retrieval > 0 ? "ok" : "needs_setup",
    detail:
      retrieval === null
        ? "could not read the query log"
        : retrieval > 0
          ? `${retrieval} successful lookups in 7 days`
          : "nothing retrieved yet: ask it a question about a document",
    blocks: [],
  });

  /* 6. Connectors. Reported, never required: a documents-only Phase 1 is a
        legitimate configuration and failing it here would make the checklist
        cry wolf on a correct deployment. */
  const connected = await safely(async () => {
    const r = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM instinct_ms_tokens`,
    );
    return Number(r.rows[0]?.n ?? 0);
  });
  checks.push({
    id: "connectors",
    proves: "Microsoft is connected",
    state: connected === null ? "unknown" : connected > 0 ? "ok" : "needs_setup",
    detail:
      connected === null
        ? "could not read the token store"
        : connected > 0
          ? `${connected} connected account(s)`
          : "no Microsoft account: calendar, mail and tasks will decline politely",
    blocks: [],
  });

  return checks;
}

/* Only when run directly. Imported by the Phase 1 command, this file must not
   also start its own report and exit the process out from under it. */
const RUN_DIRECTLY = process.argv[1]?.includes("preflight-client");

async function main(): Promise<void> {
  console.log(`Preflight for ${BASE}\n`);
  const report = assessPreflight(await gather());
  for (const line of describePreflight(report)) console.log(line);
  console.log(
    "\n  Then run the journey and the scenarios against this URL; they answer\n" +
      "  whether a person gets useful answers, which none of the above can.",
  );
  /* Exit code reflects readiness so a deploy pipeline can gate on it. */
  process.exit(report.readyToHandOver ? 0 : 1);
}

if (RUN_DIRECTLY) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
