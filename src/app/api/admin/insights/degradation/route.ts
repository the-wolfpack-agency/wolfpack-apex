/**
 * How often somebody got an answer while something underneath was broken.
 *
 * WHY THIS PAGE NEEDED IT. /admin/insights had six sections and none of them
 * was about failure. An operator could see which controls were shown to the
 * wrong roles and what model spend looked like, and could not see that the
 * product had spent the afternoon telling people their documents were missing.
 *
 * The signals existed before the page did. queryBrain has reported
 * semantic_status since 2026-08-24 and only analytics read it; callAI returned
 * a bare null for every failure. Both now reach the answer, which means both
 * now reach a row, which means an operator can finally be told.
 *
 * WHAT AN OPERATOR NEEDS FROM IT, in this order:
 *   - how many people got a degraded answer, because that is the harm
 *   - which dependency caused it, because that is the fix
 *   - how many failures were recovered silently, because a rising number
 *     there is a dependency degrading before it fails for good
 *
 * The third is the one nothing could answer before. A retry that works is
 * invisible by design: the person got their answer and nothing said the first
 * attempt failed.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { query } from "@/lib/db";
import { readAnswerOutcomes, type AnswerOutcomes } from "@/lib/insights/answer-outcomes";

export const dynamic = "force-dynamic";

interface CountRow extends Record<string, unknown> {
  n: string;
}

/** One dependency, and how often it took an answer down with it. */
export interface DegradationCause {
  kind: string;
  count: number;
}

export interface DegradationInsights {
  /** False when the event store could not be read, so a zero is not invented. */
  readable: boolean;
  days: number;
  /** Turns where a person was told something was wrong. */
  degradedAnswers: number;
  /** Which parts did not run, most frequent first. */
  causes: DegradationCause[];
  /** Failures recovered before anybody saw them. */
  retriesRecovered: number;
  /** The Brain's semantic half not running. Long-standing, tracked separately. */
  semanticDegraded: number;
  /** A knowledge lookup that failed and would once have read as an empty base. */
  knowledgeLookupFailures: number;
  /**
   * WHAT HAPPENED TO THE PERSON AFTER THE ANSWER.
   *
   * Derived from stored messages rather than emitted, so it reaches back to
   * the product's first day instead of starting at zero today. Served from
   * this route because an operator asking "what is going wrong" wants the
   * outage and the dead end on one screen: a dependency being down and a
   * person walking away are both the product failing somebody, and only one
   * of them announces itself.
   */
  outcomes?: AnswerOutcomes;
}

async function count(sql: string, params: unknown[]): Promise<number | null> {
  try {
    const r = await query<CountRow>(sql, params);
    return Number(r.rows[0]?.n ?? 0) || 0;
  } catch {
    /* Null, never 0. An unreadable store and a quiet week look identical
       otherwise, which is the exact defect this whole section exists to
       surface. */
    return null;
  }
}

export async function GET(req: NextRequest) {
  /* Same gate as the sibling insight routes. This is an operator view of what
     broke, and it names dependencies rather than data, but a failure pattern
     is still a description of our infrastructure. */
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.role !== "ceo" && user.role !== "cto" && user.role !== "evp") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const days = 30;
  const since = "timestamp > NOW() - INTERVAL '1 day' * $1";

  const [degraded, retries, semantic, knowledge] = await Promise.all([
    count(`SELECT count(*)::text AS n FROM instinct_events WHERE event_type='system.assistant_answered_degraded' AND ${since}`, [days]),
    count(`SELECT count(*)::text AS n FROM instinct_events WHERE event_type='ai.provider_retry_succeeded' AND ${since}`, [days]),
    count(`SELECT count(*)::text AS n FROM instinct_events WHERE event_type='system.brain_semantic_degraded' AND ${since}`, [days]),
    count(`SELECT count(*)::text AS n FROM instinct_events WHERE event_type='system.knowledge_lookup_failed' AND ${since}`, [days]),
  ]);

  if (degraded === null) {
    return NextResponse.json({ readable: false, days } satisfies Partial<DegradationInsights>);
  }

  /* WHICH DEPENDENCY, not just how many. The kinds are stored comma-joined
     because an analytics value is a scalar, so they are split back out here
     rather than in the page: a component counting substrings is a component
     that breaks when a kind is renamed. */
  let causes: DegradationCause[] = [];
  try {
    const r = await query<{ kinds: string | null }>(
      `SELECT metadata->>'kinds' AS kinds
         FROM instinct_events
        WHERE event_type='system.assistant_answered_degraded' AND ${since}
        LIMIT 5000`,
      [days],
    );
    const tally = new Map<string, number>();
    for (const row of r.rows) {
      for (const kind of String(row.kinds ?? "").split(",").map((k) => k.trim()).filter(Boolean)) {
        tally.set(kind, (tally.get(kind) ?? 0) + 1);
      }
    }
    causes = [...tally.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
  } catch {
    /* The headline still stands without the breakdown. */
  }

  /* Never fatal to the panel above it: a slow message table must not take the
     outage counts down with it. */
  const outcomes = await readAnswerOutcomes(90).catch(() => undefined);

  const body: DegradationInsights = {
    readable: true,
    days,
    degradedAnswers: degraded,
    causes,
    retriesRecovered: retries ?? 0,
    semanticDegraded: semantic ?? 0,
    knowledgeLookupFailures: knowledge ?? 0,
    ...(outcomes?.readable ? { outcomes } : {}),
  };
  return NextResponse.json(body);
}
