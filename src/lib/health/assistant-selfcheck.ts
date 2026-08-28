/**
 * Ask the product the questions that were wrong, in production, every night.
 *
 * WHY THIS EXISTS. On 2026-08-28 a single day's measurement found nine
 * separate failures that every test in the repo was green through:
 *
 *   - "can you send an email for me" answered "I cannot send emails directly",
 *     from cache, at zero tokens, having been stored as a fact
 *   - "how many open tasks do I have" reached no tool and was answered with
 *     brand-ambassador training PDFs
 *   - "who runs engineering" was answered from a client's curriculum slides
 *   - SharePoint search had returned 401 on every call since May
 *   - the health check watching Microsoft had never once succeeded
 *
 * Not one of those was findable from a unit test, because each needed the real
 * pipeline, the real corpus and the real credentials at once. They were found
 * by typing questions at production and reading the answers, which is not a
 * thing that happens on a schedule unless something schedules it.
 *
 * So this is that schedule. It asks a small set of questions whose right answer
 * is known, through the same chat() a person uses, and records whether the
 * product still gets them right. A regression surfaces the next morning rather
 * than in front of a client.
 *
 * WHAT IT ASSERTS, AND WHAT IT REFUSES TO.
 *
 * It asserts SHAPE, never wording. "Does this answer deny a capability we have"
 * and "did this reach a tool rather than a model" are stable properties. "Does
 * it say exactly this sentence" would fail on every copy edit and be switched
 * off within a month, which is how a guardrail dies.
 *
 * It does not assert that a question returns RESULTS. A tenant may genuinely
 * hold no document matching a probe query, and demanding hits would fail the
 * check for something that is not a fault. That distinction is the whole
 * lesson of the day: an empty answer and a broken one look identical from
 * outside, and only the code can tell you which it meant.
 *
 * WHY IT CANNOT POLLUTE WHAT IT MEASURES. It runs as a synthetic user that is
 * not on the roster, so it is invisible to the adoption figures on /pilot,
 * which count askers by joining to instinct_team_members. Its questions are
 * chosen to be answered by tools, so they never reach the model path that
 * writes to the knowledge base. That matters: my own manual testing wrote three
 * denial rows into production knowledge earlier the same day, which is exactly
 * the mistake an automated check must not repeat.
 */

import { chat } from "@/lib/assistant";
import { deniesCapability } from "@/lib/assistant/capability-denial";
import { persistProbeResult, type ProbeResult } from "@/lib/health/integration-probes";
import { trackEvent } from "@/lib/analytics";

/**
 * Not a real person, and deliberately not on the roster.
 *
 * The adoption panel counts askers by joining conversations to
 * instinct_team_members, so an id with no member row contributes to nothing it
 * would distort. Named so a human reading the events knows what it is.
 */
const PROBE_USER = "assistant-selfcheck";
const PROBE_ROLE = "cto";

interface Check {
  /** Stable id, recorded as object_type so a trend is queryable per check. */
  id: string;
  /** What a person types. */
  ask: string;
  /** What has to be true of the answer. Returns a reason when it is not. */
  expect: (answer: string, source: string) => string | null;
}

/** The answer came from a tool or a cache rather than from a model. */
function servedWithoutModel(source: string): boolean {
  return source !== "ai";
}

export const CHECKS: Check[] = [
  {
    /* The one that cost the most. It answered "I cannot send emails directly"
       from cache, and the same question had answered correctly minutes earlier
       in the same session, so an instruction in the prompt was never going to
       hold it. */
    id: "capability_email",
    ask: "can you send an email for me",
    expect: (answer, source) =>
      deniesCapability(answer)
        ? "denied a capability the product has"
        : !servedWithoutModel(source)
          ? "reached a model rather than the registry"
          : null,
  },
  {
    id: "capability_files",
    ask: "what files can you see",
    /* Checks the source as well as the answer. Written first looking only at
       the words, which the suite caught: a file question answered by a model
       would have passed while being the exact regression this exists for. The
       right answer comes from the registry, and anything else is drift even
       when the sentence reads well. */
    expect: (answer, source) =>
      deniesCapability(answer)
        ? "denied a capability the product has"
        : !servedWithoutModel(source)
          ? "reached a model rather than the registry"
          : null,
  },
  {
    /* Reached no tool at all, went to the Brain, and came back with a
       screenshot and two training PDFs about flipcharting your daily tasks. */
    id: "routing_task_count",
    ask: "how many open tasks do I have",
    expect: (answer, source) =>
      !servedWithoutModel(source) ? "reached a model rather than the tasks tool" : null,
  },
  {
    /* Answered "I cannot determine who runs engineering", citing a client's
       brand-ambassador curriculum. A question about our own org chart. */
    id: "routing_role_holder",
    ask: "who runs engineering",
    expect: (answer, source) =>
      !servedWithoutModel(source)
        ? "reached a model rather than the roster"
        : deniesCapability(answer)
          ? "refused rather than reading the roster"
          : null,
  },
  {
    /* Typed 13 times in sixty days and answered nothing every time. It is the
       name of the client's own SharePoint site. */
    id: "routing_bare_site_name",
    ask: "wolfpackxpcna",
    expect: (_answer, source) =>
      !servedWithoutModel(source) ? "reached a model rather than search" : null,
  },
  {
    /* The first question anybody types. Answering it wrong is the only thing
       standing between a new user and giving up. */
    id: "front_door",
    ask: "what can you do",
    expect: (answer, source) =>
      !servedWithoutModel(source)
        ? "reached a model rather than the registry"
        : answer.length < 40
          ? "answered with almost nothing"
          : null,
  },
];

export interface SelfCheckResult {
  id: string;
  ok: boolean;
  /** Why it failed, in the reader's terms. Absent when it passed. */
  reason?: string;
  source: string;
  durationMs: number;
}

export interface SelfCheckSummary {
  ran: number;
  failed: SelfCheckResult[];
  results: SelfCheckResult[];
}

/**
 * Run every check and persist each outcome.
 *
 * NEVER THROWS. This is called from a cron whose other work must finish. A
 * check that blows up is recorded as a failed check, which is the information
 * we wanted anyway.
 */
export async function runAssistantSelfCheck(
  workspaceId = "default",
): Promise<SelfCheckSummary> {
  const results: SelfCheckResult[] = [];

  for (const check of CHECKS) {
    const started = Date.now();
    let result: SelfCheckResult;
    try {
      const res = (await chat(check.ask, PROBE_USER, PROBE_ROLE)) as {
        response?: string;
        source?: string;
      };
      const answer = res.response ?? "";
      const source = res.source ?? "unknown";
      const reason = check.expect(answer, source);
      result = {
        id: check.id,
        ok: reason === null,
        ...(reason ? { reason } : {}),
        source,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      result = {
        id: check.id,
        ok: false,
        reason: `threw: ${(err as Error).message?.slice(0, 120) ?? "unknown"}`,
        source: "error",
        durationMs: Date.now() - started,
      };
    }

    results.push(result);

    /* Recorded in the same table as the integration probes, so "is the product
       working" is one query rather than two systems to remember. probe_kind
       "action" is the existing value for "did it DO the right thing", as
       opposed to "can we reach it" or "has its shape changed". */
    const probe: ProbeResult = {
      vendor: "assistant",
      probeKind: "action",
      objectType: check.id,
      ok: result.ok,
      ...(result.reason ? { errorMessage: result.reason } : {}),
      schemaPayload: { source: result.source },
      durationMs: result.durationMs,
    };
    await persistProbeResult(workspaceId, probe).catch(() => undefined);
  }

  const failed = results.filter((r) => !r.ok);

  /* One event carrying the whole run, so a rising failure count is visible in
     the learning loop without joining across six rows. */
  try {
    trackEvent("assistant.selfcheck_completed", PROBE_USER, PROBE_ROLE, {
      ran: results.length,
      failed: failed.length,
      failed_ids: failed.map((f) => f.id).join(","),
    });
  } catch {
    /* Analytics is best effort; the persisted rows are the record. */
  }

  return { ran: results.length, failed, results };
}
