/**
 * /admin/insights — admin dashboard surfacing three insight feeds
 * that together turn the event stream into "what to build next":
 *
 *   1. Unmet intents — phrases that fell through to the LLM,
 *      clustered + ranked by distinct-user count. This is the
 *      backlog signal.
 *   2. Integration templates — the canonical registry of every
 *      widget / form / page-facts surface paired with the external
 *      tool it mirrors. Shows last-known schema hash + use cases.
 *   3. Integration health — connectivity + schema-drift status per
 *      vendor (read from the integration_health_latest view).
 *
 * Auth: cto / ceo / evp (gate matches the underlying endpoints).
 */

"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, authHeaders, fetchWithRefresh } from "@/lib/client-auth";
import {
  compareCosts,
  PRICES_RECORDED_ON,
  type TokenUsage,
} from "@/lib/pilot/model-cost-comparison";

interface UserInfo {
  role: string;
}

/** A control somebody could see, could click, and was never allowed to use. */
interface RoleMismatch {
  control: string;
  method: string;
  surface: string;
  role: string;
  attempts: number;
  people: number;
  worstRepeat: number;
  lastSeen: string;
}

function isAdmin(user: UserInfo | null): boolean {
  return !!user && (user.role === "ceo" || user.role === "cto" || user.role === "evp");
}

/** A figure that might not have been measurable. Null is never zero. */
interface Reading { value: number | null; detail: string }

interface CapabilitySnapshot {
  windowDays: number;
  gate: { actionsAuthorized: Reading; checkpointsSigned: Reading };
  efficiency: {
    deterministicSharePct: Reading;
    modelCalls: Reading;
    cheapTierPct: Reading;
    spendUsd: Reading;
  };
  safety: { responsesRedacted: Reading; responsesFlagged: Reading; inspectorProven: boolean };
  retrieval: { chunksEmbeddedPct: Reading; answerableDocuments: Reading };
}

/** The routing score, and whether it could be read at all. */
/** What the answer path could not reach, and what it recovered from. */
interface Degradation {
  readable: boolean;
  days: number;
  degradedAnswers?: number;
  causes?: Array<{ kind: string; count: number }>;
  retriesRecovered?: number;
  semanticDegraded?: number;
  knowledgeLookupFailures?: number;
  outcomes?: {
    days: number;
    conversations: number;
    misses: number;
    deadEnds: number;
    missesFollowedUp: number;
    reAsks: number;
    singleTurnConversations: number;
    ratedAnswers: number;
    messages: number;
  };
}

interface RoutingCoverage {
  readable: boolean;
  total?: number;
  reachedOne?: number;
  reachedNone?: number;
  reachedMany?: number;
  percent?: number | null;
  deadClusters?: string[];
  unreachable?: string[];
}

interface UnmetIntent {
  normalizedText: string;
  exampleText: string;
  count: number;
  lastSeenAt: string;
  distinctUsers: number;
  brainContextRate: number;
}

interface IntegrationTemplate {
  id: string;
  templateId: string;
  surface: string;
  vendor: string;
  objectType: string | null;
  useCases: string[];
  lastKnownSchemaHash: string | null;
  fallbackFieldSet: Array<{ name: string; required?: boolean }>;
  notes: string | null;
  isActive: boolean;
}

interface HealthVendor {
  vendor: string;
  connectivity: { ok: boolean; statusCode: number | null; errorMessage: string | null; probedAt: string } | null;
  schema: Array<{
    objectType: string | null;
    ok: boolean;
    schemaHash: string | null;
    drifted: boolean;
    errorMessage: string | null;
    probedAt: string;
  }>;
}

export default function InsightsAdminPage() {
  const router = useRouter();
  const [user, setUser] = useState<UserInfo | null>(null);

  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null);
  const [intents, setIntents] = useState<UnmetIntent[] | null>(null);
  const [templates, setTemplates] = useState<IntegrationTemplate[] | null>(null);
  const [health, setHealth] = useState<HealthVendor[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const u = getInstinctUser<UserInfo>();
    setUser(u);
    if (!u) {
      router.push("/login?next=/admin/insights");
      return;
    }
    if (!isAdmin(u)) {
      router.push("/");
    }
  }, [router]);

  const [capability, setCapability] = useState<CapabilitySnapshot | null>(null);
  const [capabilityReadable, setCapabilityReadable] = useState(true);
  const [routing, setRouting] = useState<RoutingCoverage | null>(null);
  const [mismatches, setMismatches] = useState<RoleMismatch[] | null>(null);
  /* Unreadable is not the same fact as none, and rendering an empty table for
     both would claim no control in the product lies to anybody. */
  const [mismatchesReadable, setMismatchesReadable] = useState(true);
  /* What broke while somebody was waiting. Null until the first load, so an
     unread store and a quiet month are never rendered the same way. */
  const [degradation, setDegradation] = useState<Degradation | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const failures: string[] = [];
    try {
      const [intentRes, templateRes, healthRes, mismatchRes, routingRes, capabilityRes, degradationRes] = await Promise.all([
        fetchWithRefresh("/api/admin/insights/unmet-intents", { headers: authHeaders() }),
        fetchWithRefresh("/api/admin/templates", { headers: authHeaders() }),
        fetchWithRefresh("/api/health/integrations", { headers: authHeaders() }),
        fetchWithRefresh("/api/admin/insights/role-mismatches", { headers: authHeaders() }),
        fetchWithRefresh("/api/admin/insights/routing-coverage", { headers: authHeaders() }),
        fetchWithRefresh("/api/admin/insights/capability", { headers: authHeaders() }),
        fetchWithRefresh("/api/admin/insights/degradation", { headers: authHeaders() }),
      ]);
      if (degradationRes.ok) {
        setDegradation(await degradationRes.json());
      } else failures.push(`degradation: HTTP ${degradationRes.status}`);
      if (intentRes.ok) {
        const body = await intentRes.json();
        setIntents(body.intents ?? []);
      } else failures.push(`unmet-intents: HTTP ${intentRes.status}`);
      if (templateRes.ok) {
        const body = await templateRes.json();
        setTemplates(body.templates ?? []);
      } else failures.push(`templates: HTTP ${templateRes.status}`);
      if (healthRes.ok) {
        const body = await healthRes.json();
        setHealth(body.vendors ?? []);
      } else failures.push(`health: HTTP ${healthRes.status}`);
      if (mismatchRes.ok) {
        const body = await mismatchRes.json();
        setMismatches(body.mismatches ?? []);
        setMismatchesReadable(body.readable !== false);
      } else failures.push(`role-mismatches: HTTP ${mismatchRes.status}`);
      if (routingRes.ok) {
        setRouting(await routingRes.json());
      } else failures.push(`routing-coverage: HTTP ${routingRes.status}`);
      if (capabilityRes.ok) {
        const body = await capabilityRes.json();
        setCapability(body.snapshot ?? null);
        /* Same endpoint, because the token counts and the capability figures
           are read from the same window and a second round trip would let them
           disagree about which sixty days they describe. */
        setTokenUsage(body.tokenUsage ?? null);
        setCapabilityReadable(body.readable !== false);
      } else failures.push(`capability: HTTP ${capabilityRes.status}`);
    } catch (err) {
      failures.push((err as Error).message);
    }
    setErrors(failures);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (user && isAdmin(user)) loadAll();
  }, [user, loadAll]);

  if (!user) return null;
  if (!isAdmin(user)) return null;
  const costRows = tokenUsage ? compareCosts(tokenUsage) : [];


  return (
    <div className="p-6 max-w-6xl mx-auto" data-testid="insights-admin-page">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
          Insights
        </h1>
        <button
          onClick={loadAll}
          disabled={loading}
          className="px-3 py-1.5 rounded text-sm font-medium"
          style={{
            background: "var(--wp-dark-surface2)",
            color: "var(--wp-text)",
            border: "1px solid var(--wp-dark-border)",
          }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {errors.length > 0 && (
        <div
          className="mb-4 p-3 rounded text-sm"
          style={{
            background: "rgba(239,68,68,0.10)",
            color: "var(--wp-error)",
            border: "1px solid rgba(239,68,68,0.30)",
          }}
        >
          Some feeds failed to load: {errors.join("; ")}
        </div>
      )}

      {/* WHAT BROKE WHILE SOMEBODY WAS WAITING.
          Placed above the role-mismatch panel because that one names a control
          somebody could not use, and this one names an answer somebody could
          not get. Both are already broken for a person who did not tell us;
          this is the more expensive of the two.
          It did not exist until 2026-08-30, and neither did most of its
          signals. queryBrain has reported semantic_status since 2026-08-24 and
          only analytics read it; callAI returned a bare null for every failure
          so an unreachable model and an empty corpus were indistinguishable.
          Both now reach the answer, which is why they can now reach a page. */}
      <section data-testid="insights-degradation" className="mb-8">
        <h2 className="text-lg font-semibold mb-2" style={{ color: "var(--wp-text)" }}>
          Answers given while something was broken (last {degradation?.days ?? 30} days)
        </h2>
        {degradation && !degradation.readable ? (
          <p className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
            The event store could not be read, so this is not being reported. That is a different
            thing from a quiet month and is not shown as one.
          </p>
        ) : degradation ? (
          <>
            <p className="text-xs mb-3" style={{ color: "var(--wp-text-dim)" }}>
              A degraded answer names what could not be read and tells the reader nothing was lost.
              A recovered retry is one nobody saw. Rising recoveries are a dependency getting worse
              before it fails for good, which is the earliest warning available here.
            </p>
            <div className="flex flex-wrap gap-6 mb-2">
              <div data-testid="insights-degraded-answers">
                <div className="text-2xl font-semibold" style={{ color: "var(--wp-text)" }}>
                  {degradation.degradedAnswers ?? 0}
                </div>
                <div className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                  people told something was wrong
                </div>
              </div>
              <div data-testid="insights-retries-recovered">
                <div className="text-2xl font-semibold" style={{ color: "var(--wp-text)" }}>
                  {degradation.retriesRecovered ?? 0}
                </div>
                <div className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                  failures recovered before anybody saw
                </div>
              </div>
              <div data-testid="insights-semantic-degraded">
                <div className="text-2xl font-semibold" style={{ color: "var(--wp-text)" }}>
                  {degradation.semanticDegraded ?? 0}
                </div>
                <div className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                  searches that ran on keywords alone
                </div>
              </div>
              <div data-testid="insights-knowledge-failures">
                <div className="text-2xl font-semibold" style={{ color: "var(--wp-text)" }}>
                  {degradation.knowledgeLookupFailures ?? 0}
                </div>
                <div className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                  knowledge lookups that failed
                </div>
              </div>
            </div>
            {/* WHICH DEPENDENCY, because the count says there is a problem and
                only this says where to go. */}
            {degradation.causes && degradation.causes.length > 0 ? (
              <ul className="text-xs" style={{ color: "var(--wp-text-dim)" }} data-testid="insights-degradation-causes">
                {degradation.causes.map((c) => (
                  <li key={c.kind}>
                    {c.kind.replace(/_/g, " ")}: {c.count}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                Nothing has degraded an answer in this window. The checks run on every turn, so this
                is a result rather than the absence of one.
              </p>
            )}
          </>
        ) : (
          <p className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
            Loading.
          </p>
        )}
      </section>

      {/* WHAT HAPPENED TO THE PERSON AFTER THE ANSWER.
          The product emits 133 assistant events and every one describes what
          the SYSTEM did. Not one described what the PERSON did in response,
          and the response is where frustration lives. That is why the
          customer-success view could only say "joined and has done nothing
          since": it was the only behavioral signal that existed.
          Derived from stored messages rather than emitted, so it reaches back
          to the first day instead of starting at zero today. */}
      {degradation?.outcomes ? (
        <section data-testid="insights-outcomes" className="mb-8">
          <h2 className="text-lg font-semibold mb-2" style={{ color: "var(--wp-text)" }}>
            What happened after the answer (last {degradation.outcomes.days} days)
          </h2>
          <p className="text-xs mb-3" style={{ color: "var(--wp-text-dim)" }}>
            A dead end is an answer that admitted having nothing, after which the person never
            asked anything again. Each one is a request nobody filed, and it is the shortest list
            of real work this page produces.
          </p>
          <div className="flex flex-wrap gap-6 mb-2">
            <div data-testid="insights-dead-ends">
              <div className="text-2xl font-semibold" style={{ color: "var(--wp-text)" }}>
                {degradation.outcomes.deadEnds}
              </div>
              <div className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                dead ends, of {degradation.outcomes.misses} answers that had nothing
              </div>
            </div>
            <div data-testid="insights-misses-followed">
              <div className="text-2xl font-semibold" style={{ color: "var(--wp-text)" }}>
                {degradation.outcomes.missesFollowedUp}
              </div>
              <div className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                pushed past it and asked again
              </div>
            </div>
            <div data-testid="insights-reasks">
              <div className="text-2xl font-semibold" style={{ color: "var(--wp-text)" }}>
                {degradation.outcomes.reAsks}
              </div>
              <div className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                questions asked again in different words
              </div>
            </div>
            <div data-testid="insights-rated">
              <div className="text-2xl font-semibold" style={{ color: "var(--wp-text)" }}>
                {degradation.outcomes.ratedAnswers}
              </div>
              <div className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                answers anybody rated
              </div>
            </div>
          </div>
          {/* THE NUMBER THAT MEANS TWO OPPOSITE THINGS, said out loud rather
              than reported as if it were a result. */}
          <p className="text-xs" style={{ color: "var(--wp-text-dim)" }} data-testid="insights-single-turn">
            {degradation.outcomes.singleTurnConversations} of {degradation.outcomes.conversations}{" "}
            conversations were one question and no more. That means either somebody got what they
            needed or they gave up, and nothing here can tell which. The copy and source-open
            signals are what will separate them, and they start from today rather than reaching
            back.
          </p>
        </section>
      ) : null}

      {/* FIRST ON THE PAGE, deliberately. The other panels describe what to
          build next; this one names something already broken for somebody who
          did not tell us. A person shown a control their role cannot use
          clicks it, nothing happens, and they conclude the product is broken.
          The API refusing is correct, so there is nothing to harden: the work
          is on the front end, and the surface column says which page. */}
      <section data-testid="insights-role-mismatches" className="mb-8">
        <h2 className="text-lg font-semibold mb-2" style={{ color: "var(--wp-text)" }}>
          Controls shown to roles that cannot use them (last 30 days)
        </h2>
        <p className="text-xs mb-3" style={{ color: "var(--wp-text-dim)" }}>
          Someone clicked, the API correctly refused, and nothing happened on screen. Ranked by the
          most attempts by a single person, because one refusal can be a stale tab and three in a
          row is the product lying to them. Fix on the page named, not in the API.
        </p>
        {mismatches === null ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading…</p>
        ) : !mismatchesReadable ? (
          <p className="text-sm" data-testid="mismatches-unreadable" style={{ color: "var(--wp-text-dim)" }}>
            This could not be read just now. That is not the same as no mismatches: it is an
            unmeasured window, and the difference matters.
          </p>
        ) : mismatches.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
            No refused controls in the window. Either every control on screen is one its viewer can
            use, or write traffic is low — check back after more usage.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: "var(--wp-text-dim)", textAlign: "left" }}>
                <th className="py-1">Control</th>
                <th className="py-1 w-40">Shown on</th>
                <th className="py-1 w-24">Role</th>
                <th className="py-1 w-24">Worst repeat</th>
                <th className="py-1 w-20">People</th>
                <th className="py-1 w-20">Attempts</th>
              </tr>
            </thead>
            <tbody>
              {mismatches.map((m) => (
                <tr
                  key={`${m.control}-${m.method}-${m.surface}-${m.role}`}
                  className="border-t"
                  style={{ borderColor: "var(--wp-dark-border)" }}
                >
                  <td className="py-2" style={{ color: "var(--wp-text)" }}>
                    <span style={{ color: "var(--wp-text-muted)" }}>{m.method} </span>
                    {m.control}
                  </td>
                  <td className="py-2" style={{ color: "var(--wp-text)" }}>{m.surface}</td>
                  <td className="py-2" style={{ color: "var(--wp-text-dim)" }}>{m.role}</td>
                  {/* The ranking key, so it reads as the reason the row is here. */}
                  <td
                    className="py-2 font-semibold"
                    style={{ color: m.worstRepeat > 1 ? "var(--wp-gold)" : "var(--wp-text-dim)" }}
                  >
                    {m.worstRepeat}
                    {m.worstRepeat > 1 ? "\u00d7 by one person" : ""}
                  </td>
                  <td className="py-2" style={{ color: "var(--wp-text-dim)" }}>{m.people}</td>
                  <td className="py-2" style={{ color: "var(--wp-text-dim)" }}>{m.attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* WHAT OUR ROUTING IS SAVING, AS A MAINTENANCE QUESTION.
              /pilot shows a client what they are not paying. This asks whether
              the routing is still doing its job: a rising multiple means work
              has drifted onto a bigger model, and that is cheaper to catch as
              a trend here than as a bill later. Same data, different question,
              which is why it belongs on both pages rather than neither. */}
      {costRows.length > 0 && tokenUsage ? (
        <section data-testid="insights-cost-comparison" className="mb-8">
          <h2 className="text-lg font-semibold mb-2" style={{ color: "var(--wp-text)" }}>
            Model spend against the alternatives
          </h2>
          <p className="text-xs mb-3" style={{ color: "var(--wp-text-dim)" }}>
            {tokenUsage.calls.toLocaleString()} model calls,{" "}
            {tokenUsage.inputTokens.toLocaleString()} tokens in and{" "}
            {tokenUsage.outputTokens.toLocaleString()} out. What that exact traffic
            would cost at each vendor&rsquo;s published list price, recorded{" "}
            {PRICES_RECORDED_ON}. Holds the token count fixed and changes only the
            price, so it is our traffic at their rates rather than a forecast of
            their bill.
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: "var(--wp-text-dim)" }}>
                <th className="text-left font-medium pb-1">Model</th>
                <th className="text-right font-medium pb-1">Would cost</th>
                <th className="text-right font-medium pb-1">vs actual</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ color: "var(--wp-text)" }}>
                <td className="py-1">What we paid</td>
                <td className="py-1 text-right">${tokenUsage.actualUsd.toFixed(2)}</td>
                <td className="py-1 text-right">&mdash;</td>
              </tr>
              {costRows.map((c) => (
                <tr key={c.label} style={{ color: "var(--wp-text-dim)" }}>
                  <td className="py-1">{c.label}</td>
                  <td className="py-1 text-right">${c.wouldHaveCostUsd.toFixed(2)}</td>
                  <td className="py-1 text-right">
                    {c.multipleOfActual !== null ? `${c.multipleOfActual}\u00d7` : "\u2014"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {/* THE CAPABILITY FIGURES MOVED TO /pilot.
              What a model costs, how little of the product needs one, and what
              the router stopped from leaving are the CLIENT'S questions. They
              were here, on a page gated to three roles, mixed in with OUR
              backlog signals: unmet intents, routing coverage, controls shown
              to a role that cannot use them.

              Two audiences sharing one page is most of why this page read as
              jumbled and overwhelming. This page is now ours alone: what to
              build next. The client dashboard is /pilot. */}

      {/* BESIDE THE ROLE-MISMATCH PANEL, because they answer the same question
          from opposite ends. That one names a control the product showed
          somebody who could not use it. This one names a sentence somebody
          typed that the product could not route anywhere at all. Both are
          "where is this failing its users", and neither is visible in any
          other number the company looks at. */}
      <section data-testid="insights-routing-coverage" className="mb-8">
        <h2 className="text-lg font-semibold mb-2" style={{ color: "var(--wp-text)" }}>
          Ordinary sentences that reach a tool
        </h2>
        <p className="text-xs mb-3" style={{ color: "var(--wp-text-dim)" }}>
          A fixed corpus of prompts a person would plainly type, scored against every tool&apos;s
          intent matcher. Computed live, so it cannot be a number that was true at deploy time.
          A prompt reaching NOTHING falls through to a model, which answers from whatever the
          knowledge base had nearest.
        </p>
        {routing === null ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading…</p>
        ) : !routing.readable ? (
          <p className="text-sm" data-testid="routing-unreadable" style={{ color: "var(--wp-text-dim)" }}>
            This could not be read just now. That is not a score of zero: it is an unmeasured
            window, and the difference matters.
          </p>
        ) : (
          <>
            <div className="flex items-baseline gap-6 mb-3">
              <div>
                <div
                  data-testid="routing-percent"
                  className="text-3xl font-semibold"
                  style={{ color: "var(--wp-gold)" }}
                >
                  {routing.percent === null ? "n/a" : `${routing.percent}%`}
                </div>
                <div className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                  {routing.reachedOne} of {routing.total} reach exactly one tool
                </div>
              </div>
              <div>
                <div className="text-2xl font-semibold" style={{ color: "var(--wp-text)" }}>
                  {routing.reachedNone}
                </div>
                <div className="text-xs" style={{ color: "var(--wp-text-dim)" }}>reach nothing</div>
              </div>
              <div>
                <div className="text-2xl font-semibold" style={{ color: "var(--wp-text-dim)" }}>
                  {routing.reachedMany}
                </div>
                <div className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                  more than one (may be fine)
                </div>
              </div>
            </div>

            {/* A whole cluster failing is a MISSING CAPABILITY, not a missing
                phrasing, and it is a different decision for a different
                person. Called out rather than buried in the list below. */}
            {routing.deadClusters && routing.deadClusters.length > 0 && (
              <p
                data-testid="routing-dead-clusters"
                className="text-sm mb-2"
                style={{ color: "var(--wp-error, #dc2626)" }}
              >
                Whole clusters unreachable: {routing.deadClusters.join(", ")}. Every phrasing in
                these fails, so no regex will fix them. Nothing is built that answers the question.
              </p>
            )}

            {routing.unreachable && routing.unreachable.length > 0 && (
              <details>
                <summary className="text-xs cursor-pointer" style={{ color: "var(--wp-text-dim)" }}>
                  {routing.unreachable.length} prompts reaching nothing
                </summary>
                <ul className="mt-2 space-y-1" data-testid="routing-unreachable-list">
                  {routing.unreachable.map((p) => (
                    <li key={p} className="text-sm" style={{ color: "var(--wp-text)" }}>
                      {p}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </section>

      <section data-testid="insights-unmet-intents" className="mb-8">
        <h2 className="text-lg font-semibold mb-2" style={{ color: "var(--wp-text)" }}>
          Unmet intents (last 7 days)
        </h2>
        <p className="text-xs mb-3" style={{ color: "var(--wp-text-dim)" }}>
          Phrases users typed that no deterministic tool matched. Ranked by distinct users, then count.
        </p>
        {intents === null ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading…</p>
        ) : intents.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
            No unmet intents in the window. Either every prompt routed to a deterministic tool, or
            traffic is low — check back after more usage.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: "var(--wp-text-dim)", textAlign: "left" }}>
                <th className="py-1">Phrase</th>
                <th className="py-1 w-20">Users</th>
                <th className="py-1 w-20">Count</th>
                <th className="py-1 w-32">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {intents.map((i) => (
                <tr key={i.normalizedText} className="border-t" style={{ borderColor: "var(--wp-dark-border)" }}>
                  <td className="py-2" style={{ color: "var(--wp-text)" }}>
                    {i.exampleText}
                  </td>
                  <td className="py-2" style={{ color: "var(--wp-text-dim)" }}>{i.distinctUsers}</td>
                  <td className="py-2" style={{ color: "var(--wp-text-dim)" }}>{i.count}</td>
                  <td className="py-2 text-xs" style={{ color: "var(--wp-text-muted)" }}>
                    {new Date(i.lastSeenAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section data-testid="insights-templates" className="mb-8">
        <h2 className="text-lg font-semibold mb-2" style={{ color: "var(--wp-text)" }}>
          Integration templates
        </h2>
        <p className="text-xs mb-3" style={{ color: "var(--wp-text-dim)" }}>
          Every widget + form, the vendor it mirrors, what it&apos;s used for, last-known schema.
        </p>
        {templates === null ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading…</p>
        ) : templates.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
            No templates registered. Run migration 141.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: "var(--wp-text-dim)", textAlign: "left" }}>
                <th className="py-1">Template</th>
                <th className="py-1 w-24">Surface</th>
                <th className="py-1 w-28">Vendor</th>
                <th className="py-1 w-28">Object</th>
                <th className="py-1">Use cases</th>
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-t" style={{ borderColor: "var(--wp-dark-border)" }}>
                  <td className="py-2 font-mono text-xs" style={{ color: "var(--wp-text)" }}>{t.templateId}</td>
                  <td className="py-2 text-xs" style={{ color: "var(--wp-text-dim)" }}>{t.surface}</td>
                  <td className="py-2 text-xs" style={{ color: "var(--wp-text-dim)" }}>{t.vendor}</td>
                  <td className="py-2 text-xs" style={{ color: "var(--wp-text-dim)" }}>{t.objectType ?? "—"}</td>
                  <td className="py-2 text-xs" style={{ color: "var(--wp-text-muted)" }}>
                    {t.useCases.join("; ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section data-testid="insights-health" className="mb-8">
        <h2 className="text-lg font-semibold mb-2" style={{ color: "var(--wp-text)" }}>
          Integration health
        </h2>
        <p className="text-xs mb-3" style={{ color: "var(--wp-text-dim)" }}>
          Latest connectivity + schema-drift status per vendor. <code>drifted</code> = the latest
          schema hash differs from the previous one.
        </p>
        {health === null ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading…</p>
        ) : health.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
            No probe data yet. Hit <code>?run=true</code> on the health endpoint or wait for the
            nightly orchestrator.
          </p>
        ) : (
          <div className="space-y-3">
            {health.map((v) => (
              <div
                key={v.vendor}
                className="rounded p-3"
                style={{ background: "var(--wp-dark-surface)", border: "1px solid var(--wp-dark-border)" }}
              >
                <div className="flex items-center justify-between">
                  <div className="font-semibold" style={{ color: "var(--wp-text)" }}>{v.vendor}</div>
                  {v.connectivity ? (
                    <span
                      className="text-xs px-2 py-0.5 rounded"
                      style={{
                        background: v.connectivity.ok ? "rgba(34,197,94,0.10)" : "rgba(239,68,68,0.10)",
                        color: v.connectivity.ok ? "var(--wp-success, #22c55e)" : "var(--wp-error)",
                      }}
                    >
                      {v.connectivity.ok ? "connected" : v.connectivity.errorMessage ?? "down"}
                    </span>
                  ) : (
                    <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>no probe</span>
                  )}
                </div>
                {v.schema.length > 0 && (
                  <table className="w-full text-xs mt-2">
                    <thead>
                      <tr style={{ color: "var(--wp-text-dim)", textAlign: "left" }}>
                        <th className="py-0.5">Object</th>
                        <th className="py-0.5 w-16">OK</th>
                        <th className="py-0.5 w-16">Drift</th>
                        <th className="py-0.5">Hash</th>
                      </tr>
                    </thead>
                    <tbody>
                      {v.schema.map((s) => (
                        <tr key={`${v.vendor}-${s.objectType}`} className="border-t" style={{ borderColor: "var(--wp-dark-border)" }}>
                          <td className="py-1" style={{ color: "var(--wp-text)" }}>{s.objectType ?? "—"}</td>
                          <td className="py-1" style={{ color: s.ok ? "var(--wp-success, #22c55e)" : "var(--wp-error)" }}>
                            {s.ok ? "✓" : "✗"}
                          </td>
                          <td className="py-1" style={{ color: s.drifted ? "var(--wp-warning, #eab308)" : "var(--wp-text-muted)" }}>
                            {s.drifted ? "drifted" : "stable"}
                          </td>
                          <td className="py-1 font-mono" style={{ color: "var(--wp-text-muted)" }}>
                            {s.schemaHash ? s.schemaHash.slice(0, 12) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
