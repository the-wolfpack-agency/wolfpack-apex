"use client";

/**
 * /admin/ai-router - which models this platform can use, which it chose, and
 * what that is estimated to have cost.
 *
 * WHAT WAS ALREADY THERE
 *
 * The router (lib/ai/models) has chosen a model per call for some time: tiers,
 * pins, cost-weighted selection, a logged reason for every decision. None of it
 * was visible anywhere. A routing engine nobody can see is a set of defaults
 * nobody is checking, so this adds no engine, only the surface over it.
 *
 * ESTIMATED IS NOT BILLED
 *
 * Every cost here is list price times a token estimate formed BEFORE the call
 * ran. It knows nothing about cached input, batch pricing, or what the call
 * actually consumed. The word "estimated" appears on every figure, and the page
 * says out loud when decisions carried no estimate at all — otherwise someone
 * reconciles this against an invoice, finds it wrong, and stops trusting the
 * whole surface.
 *
 * THE LIST IS WHAT THIS PLATFORM CAN REACH, AND NOTHING ELSE
 *
 * This panel used to list every registered model and name the missing variable
 * for the unconfigured ones, on the reasoning that "Unavailable" sends someone
 * digging. What that produced in practice was seven rows where four models are
 * reachable, because the unconfigured ones were the OpenAI-hosted twins of
 * Azure models that ARE configured, each carrying a price nothing would ever be
 * billed at. A duplicate that cannot serve a request is not information, it is
 * a longer list.
 *
 * The registry still holds them, which is what makes swapping a provider a
 * one-line change. The panel is titled "models this platform can reach" and now
 * means it. Whether a specific model is reachable is a different question, and
 * the button below answers it properly by asking the model.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, fetchWithRefresh } from "@/lib/client-auth";
import { GlassPanel, MetricTile, SectionHeader, StatusPill, ConsoleGrid, ConsoleShell } from "@/components/console";
import type { SeverityTone } from "@/components/console";
import RouterFlow from "@/components/admin/RouterFlow";
import RouterExplainer from "@/components/admin/RouterExplainer";
import type { RouterInsights } from "@/lib/ai/models/insights";
import { summariseQuality, type SignalTrend } from "@/lib/learning/answer-quality";
import type { QualityWeek } from "@/lib/learning/answer-quality";
import type { ProbeReport } from "@/lib/ai/models/probe";

/** Accept only well-shaped payloads. A response that is not what we expect must
 *  render as "nothing recorded" rather than throw and blank the page: version
 *  skew during a deploy makes that a real scenario, not a hypothetical. */
function normalize(raw: unknown): RouterInsights | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Partial<RouterInsights>;
  if (!Array.isArray(b.models) || !Array.isArray(b.usage) || !Array.isArray(b.reasons)) return null;
  return {
    /* Absent means no. An older deploy, or a payload that lost the field,
       must not silently offer a control the server will refuse. */
    canProbe: b.canProbe === true,
    /* Absent on a payload from a deploy that predates the retry, which is a
       different thing from "no retries happened" and must not be reported as
       a confident zero. Normalised to 0 here and the tile says which. */
    retriesRecovered: typeof b.retriesRecovered === "number" ? b.retriesRecovered : 0,
    days: typeof b.days === "number" ? b.days : 30,
    totalDecisions: b.totalDecisions ?? 0,
    estimatedCostUsd: b.estimatedCostUsd ?? 0,
    decisionsWithoutEstimate: b.decisionsWithoutEstimate ?? 0,
    usage: b.usage,
    reasons: b.reasons,
    fallbacks: b.fallbacks ?? 0,
    models: b.models,
    smallTierShare: typeof b.smallTierShare === "number" ? b.smallTierShare : null,
    headline: typeof b.headline === "string" ? b.headline : "",
    /* Named here or it does not exist. See the warning below: this rebuilds
       the payload field by field, and the actuals were lost for exactly this
       reason. */
    quality: b.quality,
    /* MEASURED SPEND, and it must be listed HERE or it does not exist.
       This function rebuilds the payload field by field, so a field the API
       started returning but this list does not name is silently dropped. That
       is what happened to the actuals: the query was fixed, the API returned
       them, and the page kept rendering as though there were none. A
       whitelist is the right shape for surviving version skew, and this is its
       one cost: adding a field means adding it in two places. Optional on
       purpose, so a payload from an older deploy still renders. */
    ...(b.protection && typeof b.protection === "object" ? { protection: b.protection } : {}),
    ...(b.refusals && typeof b.refusals === "object" ? { refusals: b.refusals } : {}),
    ...(typeof b.actualCostUsd === "number" ? { actualCostUsd: b.actualCostUsd } : {}),
    ...(typeof b.actualCalls === "number" ? { actualCalls: b.actualCalls } : {}),
    ...(typeof b.inputTokens === "number" ? { inputTokens: b.inputTokens } : {}),
    ...(typeof b.outputTokens === "number" ? { outputTokens: b.outputTokens } : {}),
    ...(Array.isArray(b.versions) ? { versions: b.versions } : {}),
  };
}

const usd = (n: number) => `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`;

export default function AiRouterPage() {
  const router = useRouter();
  const [data, setData] = useState<RouterInsights | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeReport | null>(null);
  const [probing, setProbing] = useState(false);
  /* WHEN these numbers were read, and a way to read them again. A page of
     counters with no timestamp cannot be told apart from a page that has
     stopped updating, which is exactly how this one was read. */
  const [refreshing, setRefreshing] = useState(false);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  // Deliberately a click and not an effect. A probe is a real inference call
  // against every configured provider, so it happens because someone asked.
  const runProbe = useCallback(async () => {
    setProbing(true);
    setProbeError(null);
    try {
      const res = await fetchWithRefresh("/api/admin/ai-router/probe", { method: "POST" });
      if (!res.ok) {
        setProbeError(`The test could not run (HTTP ${res.status}).`);
        return;
      }
      setProbe((await res.json()) as ProbeReport);
    } catch {
      setProbeError("The test could not run.");
    } finally {
      setProbing(false);
    }
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      /* cache: "no-store" as well as the response header. The header stops the
         browser reusing a stored copy; this stops it from being written in the
         first place, and the two together are what makes a refresh mean
         refresh. */
      const res = await fetchWithRefresh("/api/admin/ai-router", { cache: "no-store" });
      if (!res.ok) {
        setError(`Could not load the router (HTTP ${res.status}).`);
        return;
      }
      setData(normalize(await res.json()));
    } catch {
      setError("Could not reach the router.");
    } finally {
      setLoading(false);
      setRefreshing(false);
      setLoadedAt(new Date());
    }
  }, []);

  useEffect(() => {
    // Redirect unauthenticated users; never render a blank state.
    if (!getInstinctUser<{ role: string }>()) {
      router.push("/login?next=/admin/ai-router");
      return;
    }
    void load();
  }, [router, load]);

  return (
    /* The shared frame, so this page, /admin/agents and /assistant read as one
       product rather than three. The shell owns width, rhythm and the ambient
       backdrop; everything inside is unchanged. */
    <ConsoleShell testId="ai-router-shell">
      <SectionHeader
        as="h1"
        eyebrow="OGIAM"
        title="Model router"
        subtitle="Which models this platform can use, which one it chose for each call, and why."
      />

      {/* WHEN THIS WAS READ, AND A WAY TO READ IT AGAIN.
          Reported 2026-08-19: "this doesn't seem to update". Counters with no
          timestamp cannot be told apart from counters that have stopped, and
          the only way to get new ones was a full page load. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.75rem",
          flexWrap: "wrap",
          marginTop: "-0.5rem",
        }}
      >
        <button
          type="button"
          onClick={() => void load()}
          disabled={refreshing}
          data-testid="router-refresh"
          style={{
            border: "1px solid var(--wp-dark-border, rgba(255,255,255,0.14))",
            background: "transparent",
            color: "var(--wp-text, #e8eaed)",
            borderRadius: "8px",
            padding: "0.35rem 0.8rem",
            fontSize: "0.8rem",
            cursor: refreshing ? "default" : "pointer",
            opacity: refreshing ? 0.6 : 1,
          }}
        >
          {refreshing ? "Reading..." : "Refresh"}
        </button>
        {loadedAt ? (
          <span
            style={{ fontSize: "0.76rem", color: "var(--wp-text-muted, #9aa0aa)" }}
            data-testid="router-loaded-at"
          >
            Read at {loadedAt.toLocaleTimeString()}
          </span>
        ) : null}
      </div>

      {error && (
        <GlassPanel>
          <p role="alert" data-testid="router-error">
            {error}
          </p>
        </GlassPanel>
      )}

      {/* FOR SOMEBODY WHO HAS TO EXPLAIN THIS TO A CLIENT. Kept first on the
          page because the numbers below mean nothing to a reader who does not
          yet know what the router is for, but FOLDED (2026-08-20): the people
          who open this page daily already know, and two explanations in full
          pushed the analytics below the fold on a laptop. Shut, both are one
          line each and the spend is visible on arrival. */}
      <GlassPanel
        collapsible
        title="What this does, in plain words"
        subtitle="Read this before explaining the router to a client. Five claims, each with the panel on this page that proves it."
        testId="router-explainer-panel"
      >
        <RouterExplainer />
      </GlassPanel>

      {/* WHAT THE NUMBERS BELOW ARE ABOUT. The page reported decisions, models
          and costs to a reader with no way of knowing what a decision was. */}
      <GlassPanel
        collapsible
        title="How a question gets to a model"
        subtitle="The path every message takes, from typed question to recorded cost."
        testId="router-flow-panel"
      >
        <RouterFlow />
      </GlassPanel>

      {/* WHAT WAS KEPT IN. Coverage first, findings second, deliberately: a
          client is buying "nothing leaves unchecked", and a low findings count
          means people pasted few secrets, which is good news that a
          "blocked: 3" headline would read as a weak product. */}
      {data?.protection ? (
        <GlassPanel
          title="What the router kept in"
          subtitle="Credentials and financial identifiers are found and replaced before a question leaves us, and again before an answer is shown or stored. Every call, both directions, whichever model answers."
        >
          <ConsoleGrid>
            <MetricTile
              value={data.protection.callsChecked}
              label="Calls checked"
              kicker="Every completion, no exceptions"
              testId="router-metric-checked"
            />
            <MetricTile
              value={data.protection.itemsWithheld}
              label="Withheld on the way out"
              kicker="Never reached the model"
              testId="router-metric-withheld"
            />
            {/* The return path. A model can quote a credential it was handed
                in the conversation, an attachment or a retrieved document, and
                that answer is rendered and stored on the message row. Counted
                separately from the outbound figure because leaving and coming
                back are different events with different fixes. */}
            <MetricTile
              value={data.protection.itemsWithheldFromAnswers ?? 0}
              label="Withheld on the way back"
              kicker="Never reached the screen"
              testId="router-metric-withheld-in"
            />
          </ConsoleGrid>
          {data.protection.kinds.length > 0 ? (
            <p style={notice} data-testid="router-protection-kinds">
              Found: {data.protection.kinds.map((k) => `${k.kind.replace(/_/g, " ")} (${k.count})`).join(", ")}.
              The gate stores what KIND was found and never the value, so this list cannot leak what it caught.
            </p>
          ) : (
            <p style={notice} data-testid="router-protection-clean">
              Nothing had to be withheld in this window. That is the good outcome: the check ran on every
              call and found nothing that should not leave.
            </p>
          )}
        </GlassPanel>
      ) : null}

      {/* WHAT THE ROUTER WOULD NOT LET THROUGH, and why.
          The panel above is about VALUES: a card number, a key. This one is
          about CLAIMS -- a quoted finance rate, a price guarantee, a warranty
          decision -- which carry no redactable token and are the ones a client
          is actually held to. Each row names the rule, so a client can read
          the reasoning and argue with it rather than trusting a count. */}
      {/* WHAT EACH CHECK CAUGHT. The panel above says what the router refused;
          this says what the checks around it did, one card per check.

          Every figure is shown NEXT TO THE VOLUME IT WAS MEASURED AGAINST.
          Flagged falling from ten a week to two is good news when volume held
          and hidden bad news when volume collapsed or a checker stopped
          running: the same number, opposite meanings. A rate over an empty
          denominator renders as "n/a" rather than 0%, because a zero in a
          column of rates reads as a clean week to anybody scanning it, and
          that is exactly the week nothing was checked.

          Each card also says whether the check CHANGED the delivered answer or
          merely recorded one. That distinction was missing, and its absence
          had the page telling a client that flagged answers were stopped when
          the router logs them and delivers them. */}
      {data?.quality ? (
        <GlassPanel
          title="What the router caught, and what it only recorded"
          subtitle="One row per check, most recent week against everything before it. Rates are per 1,000 model answers so a busier week does not read as a worse one, and a direction is stated only where there is an earlier result to compare against."
        >
          {!data.quality.readable ? (
            <p data-testid="router-quality-unreadable">
              The trend could not be read. This is not a clean week: it is an unmeasured one.
            </p>
          ) : data.quality.empty ? (
            <p data-testid="router-quality-empty">
              No model calls in this window, so there is nothing to measure quality against.
            </p>
          ) : (
            <QualityPanelBody weeks={data.quality.weeks} />
          )}
        </GlassPanel>
      ) : null}

      {data?.refusals ? (
        <GlassPanel
          title="What the router would not let through"
          subtitle="Answers are checked for claims the business cannot stand behind before anyone reads them. Deterministic rules, set per tenant, applied whichever model answered."
        >
          <ConsoleGrid>
            <MetricTile
              value={data.refusals.blocked}
              label="Withheld"
              kicker="A claim we cannot be held to"
              testId="router-metric-blocked"
            />
            <MetricTile
              value={data.refusals.escalated}
              label="Sent to a person"
              kicker="A question we are not the right party to answer"
              testId="router-metric-escalated"
            />
            <MetricTile
              value={data.refusals.redacted}
              label="Trimmed"
              kicker="The claim removed, the answer kept"
              testId="router-metric-trimmed"
            />
          </ConsoleGrid>
          {data.refusals.rules.length > 0 ? (
            <ul style={ruleList} data-testid="router-refusal-rules">
              {data.refusals.rules.map((r) => (
                <li key={r.rule} style={ruleItem}>
                  <span style={ruleHead}>
                    {r.title} <span style={ruleCount}>{r.count}</span>
                  </span>
                  {/* The REASON, not the sentence that tripped it. A client
                      reading this is deciding whether the rule is right, and
                      the blocked text is the one thing we deliberately never
                      kept. */}
                  <span style={ruleWhy}>{r.why}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p style={notice} data-testid="router-refusal-clean">
              Nothing had to be held back in this window. The check ran on every answer and found no claim
              the business could not stand behind.
            </p>
          )}
          {data.refusals.profiles.length > 0 ? (
            <p style={notice} data-testid="router-refusal-profiles">
              Rule set in force: {data.refusals.profiles.join(", ")}.
            </p>
          ) : null}
        </GlassPanel>
      ) : null}

      <GlassPanel title="Activity" subtitle={data ? `Last ${data.days} days` : undefined}>
        {loading ? (
          <p style={dim} data-testid="router-loading">
            Checking…
          </p>
        ) : !data ? (
          <p style={dim} data-testid="router-unavailable">
            No routing activity could be read. That is not the same as no activity having happened.
          </p>
        ) : (
          <>
            <p style={{ marginBottom: "0.9rem" }} data-testid="router-headline">
              {data.headline}
            </p>
            <ConsoleGrid minColWidth={180}>
              <MetricTile value={data.totalDecisions} label="Routing decisions" testId="router-metric-decisions" />
              {/* WHAT IT ACTUALLY COST, as the headline number.
                  This tile showed "Estimated cost / List price, not billed",
                  computed from a token guess made BEFORE the answer existed,
                  and it read $0.0012 against real spend it never looked at.
                  ai.completion carries the provider's own billed figure for
                  every call; that is what a router is judged on, so that is
                  what the tile shows. The estimate stays available below for
                  the calls that never completed. */}
              <MetricTile
                display={usd(data.actualCostUsd ?? 0)}
                label="Total spent"
                kicker={
                  data.actualCalls
                    ? `${data.actualCalls} completed call${data.actualCalls === 1 ? "" : "s"}, billed by the provider`
                    : "No completed calls recorded"
                }
                testId="router-metric-spend"
              />
              <MetricTile
                display={(data.outputTokens ?? 0).toLocaleString()}
                label="Output tokens"
                kicker={`${(data.inputTokens ?? 0).toLocaleString()} in`}
                testId="router-metric-tokens"
              />
              <MetricTile
                display={data.smallTierShare === null ? "n/a" : `${Math.round(data.smallTierShare * 100)}%`}
                label="Served by cheapest tier"
                testId="router-metric-cheap"
              />
              <MetricTile value={data.fallbacks} label="Fell back" kicker="Preferred model unavailable" testId="router-metric-fallbacks" />
              {/* THE RECOVERY THAT APPLIES TO THIS DEPLOYMENT.
                  A fallback needs a second provider to swap to, and
                  pickFallback returns null unless Anthropic is keyed, which it
                  is not here. So "Fell back" will read zero however much goes
                  wrong, and until 2026-08-30 that zero was accurate for the
                  worst possible reason: there was no recovery at all and every
                  transient failure ended somebody's question.
                  A retry is what actually saves a turn here, and it is
                  invisible by design: the person got their answer and nothing
                  said the first attempt failed. Counting it is what turns a
                  silent success into evidence, and into early warning that a
                  dependency is degrading before it fails for good. */}
              <MetricTile
                value={data.retriesRecovered}
                label="Recovered by retry"
                kicker="A blip nobody saw"
                testId="router-metric-retries"
              />
            </ConsoleGrid>
            {/* The caveat now only appears when there is genuinely nothing
                measured, which means completions are not being recorded: a
                different and worse problem than a missing estimate. When spend
                IS measured, the old sentence apologised for a number nobody
                was being shown any more. */}
            {!data.actualCalls && data.decisionsWithoutEstimate > 0 && (
              <p style={notice} data-testid="router-estimate-caveat">
                No completed calls have been recorded, so spend cannot be measured.{" "}
                {data.decisionsWithoutEstimate} decision{data.decisionsWithoutEstimate === 1 ? "" : "s"} carried no cost
                estimate either.
              </p>
            )}
          </>
        )}
      </GlassPanel>


      {/* WHAT THE PROVIDER CHANGED UNDERNEATH YOU.
          Every other panel on this page keys on a model id, and an id is a name
          whose meaning the provider can change without telling anybody:
          "gpt-4o" has meant several different sets of weights. This is the only
          panel that reports the thing itself rather than the name, which makes
          it the one that explains why answers changed on a week nobody
          deployed. */}
      {data?.versions && data.versions.length > 0 ? (
        <GlassPanel
          title="Which weights actually answered"
          subtitle="A model name is not a version. This is what the provider reported serving, and when that changed."
        >
          <ul style={list} data-testid="router-versions">
            {data.versions.map((v) => (
              <li key={v.modelId} style={row}>
                <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
                  <strong>{v.modelId}</strong>
                  <StatusPill
                    status={v.versionsSeen > 1 ? "changed" : "steady"}
                    label={v.versionsSeen > 1 ? `${v.versionsSeen} versions seen` : "unchanged"}
                    tone={v.versionsSeen > 1 ? "warning" : "success"}
                    size="sm"
                  />
                </div>
                <p style={{ ...dim, margin: "0.3rem 0 0", fontSize: "0.85rem" }}>
                  Serving {v.currentVersion} ({v.callsOnCurrent.toLocaleString()} calls)
                </p>
                {v.previousVersion ? (
                  <p
                    style={{ ...dim, margin: "0.2rem 0 0", fontSize: "0.85rem" }}
                    data-testid="router-version-change"
                  >
                    {/* First seen HERE, not shipped: we cannot know a provider's
                        release date, and saying so would be a claim about
                        somebody else's process. */}
                    Replaced {v.previousVersion}
                    {v.changedAt ? `, first seen here ${new Date(v.changedAt).toLocaleDateString()}` : ""}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </GlassPanel>
      ) : null}

      {data && data.usage.length > 0 && (
        <GlassPanel title="Which models were used">
          <ul style={list} data-testid="router-usage">
            {data.usage.map((u) => (
              <li key={u.modelId} style={row}>
                <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
                  <strong>{u.modelId}</strong>
                  <StatusPill status={String(u.tier)} size="sm" />
                  <span style={dim}>{u.provider}</span>
                </div>
                {/* MEASURED FIRST, ESTIMATED ONLY AS A FALLBACK.
                    This read "$0.00 estimated (12 without an estimate)", which
                    apologised for a number instead of reporting the one we
                    had: ai.completion has carried the provider's own tokens
                    and cost all along and was never read here. An estimate
                    made before the answer exists cannot know how long the
                    answer will be; the measured figure does not have to
                    guess. */}
                <p style={{ ...dim, margin: "0.3rem 0 0" }}>
                  {u.actualCalls
                    ? `${u.actualCalls} call${u.actualCalls === 1 ? "" : "s"} completed, ${usd(u.actualCostUsd ?? 0)} spent`
                    : `${u.decisions} selection${u.decisions === 1 ? "" : "s"}, no completed call recorded`}
                  {u.outputTokens
                    ? `, ${(u.inputTokens ?? 0).toLocaleString()} in / ${u.outputTokens.toLocaleString()} out`
                    : ""}
                  {u.fallbacks > 0 ? `, ${u.fallbacks} after a fallback` : ""}.
                </p>
                {u.actualCalls && u.decisions > u.actualCalls ? (
                  <p style={{ ...dim, margin: "0.15rem 0 0", fontSize: "0.75rem" }}>
                    Chosen {u.decisions} times; {u.decisions - u.actualCalls} of those never
                    completed a call, so they cost nothing.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        </GlassPanel>
      )}

      {data && data.reasons.length > 0 && (
        <GlassPanel title="Why those models were chosen">
          <ul style={list} data-testid="router-reasons">
            {data.reasons.map((r) => (
              <li key={r.reason} style={row}>
                <strong>{r.count}</strong> <span>{r.description}</span>
              </li>
            ))}
          </ul>
        </GlassPanel>
      )}

      {data && (
        <GlassPanel
          title="Models this platform can reach"
          subtitle="Availability is read from the deployment's configuration. It is not editable here: changing which models serve every AI call belongs in a deployment with a review, not a form."
        >
          {/* THE READING IS FOR EVERYONE, THE SPENDING IS NOT. Every seat can
              see how the router chose and what it cost; the probe sends a real
              request to each configured model, so it stays with the roles that
              manage the deployment. Hidden rather than disabled: a control that
              is permanently dead teaches somebody the page is broken. */}
          {data.canProbe ? (
          <div style={{ marginBottom: "0.9rem" }}>
            <button type="button" onClick={() => void runProbe()} disabled={probing} style={button} data-testid="router-probe-run">
              {probing ? "Testing…" : "Test each model"}
            </button>
            <p style={{ ...dim, margin: "0.45rem 0 0", fontSize: "0.85rem" }}>
              &ldquo;Available&rdquo; below means the configuration is present. It cannot tell a working deployment from a
              typo, a deleted deployment or a rotated key. This sends a one-token request to each configured model and
              reports which ones answered. It costs a fraction of a cent.
            </p>
            {probeError && (
              <p role="alert" style={{ ...dim, margin: "0.45rem 0 0" }} data-testid="router-probe-error">
                {probeError}
              </p>
            )}
            {probe && (
              <div style={notice} data-testid="router-probe-result">
                <p style={{ margin: 0 }}>{probe.headline}</p>
                <ul style={{ ...list, marginTop: "0.6rem" }}>
                  {probe.results
                    .filter((r) => r.outcome !== "not-configured")
                    .map((r) => (
                      <li key={r.modelId} style={row}>
                        <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
                          <StatusPill
                            status={r.outcome}
                            label={r.outcome === "reachable" ? "Answered" : "Did not answer"}
                            tone={r.outcome === "reachable" ? "success" : "error"}
                            size="sm"
                          />
                          <strong>{r.modelId}</strong>
                          {r.latencyMs !== null && <span style={dim}>{r.latencyMs}ms</span>}
                        </div>
                        {r.detail && <p style={{ ...dim, margin: "0.3rem 0 0", fontSize: "0.85rem" }}>{r.detail}</p>}
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </div>
          ) : null}
          <ul style={list} data-testid="router-models">
            {/* Only what the platform can actually reach. The unconfigured rows
                were the OpenAI-hosted twins of Azure models that ARE configured
                (gpt-4o next to azure-gpt-4o), so the list read as seven models
                when it is four, and the duplicates carried prices nothing would
                ever be billed at. The registry still holds them, because that is
                what makes swapping a provider a one-line change; this panel is
                titled "models this platform can reach" and now means it. */}
            {data.models
              .filter((m) => m.available)
              .map((m) => (
              <li key={m.modelId} style={row}>
                <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
                  <StatusPill
                    status={m.available ? "available" : "unavailable"}
                    label={m.available ? "Available" : "Not configured"}
                    tone={m.available ? "success" : "neutral"}
                    size="sm"
                  />
                  <strong>{m.modelId}</strong>
                  <span style={dim}>
                    {m.provider} · {m.tier} · {m.contextWindow.toLocaleString()} tokens
                  </span>
                </div>
                <p style={{ ...dim, margin: "0.3rem 0 0", fontSize: "0.85rem" }}>
                  ${m.inputPricePer1kUsd}/1k in, ${m.outputPricePer1kUsd}/1k out
                  {m.blockedBy ? ` — ${m.blockedBy}` : ""}
                </p>
                {/* WHERE IT RUNS, and what to do when nobody has said.
                    An undeclared region is not cosmetic: a request that
                    requires a region is REFUSED by a model in this state, so
                    the difference between this line reading "eu" and reading
                    "not declared" is the difference between a working estate
                    and a puzzling one. Naming the variable is the same
                    courtesy the blocked-by line already pays. */}
                <p
                  style={{ ...dim, margin: "0.2rem 0 0", fontSize: "0.85rem" }}
                  data-testid="router-model-region"
                >
                  {m.servedIn && m.servedIn !== "unknown" ? (
                    <>Runs in {m.servedIn.toUpperCase()}</>
                  ) : (
                    <>Region not declared. Set {m.regionEnvVar} to allow requests that require one.</>
                  )}
                </p>
                </li>
              ))}
          </ul>
        </GlassPanel>
      )}
    </ConsoleShell>
  );
}

/* ---------------------------------------------------------------------------
 * The quality panel
 *
 * WAS a seven-column table with one row per week. Against the real history it
 * rendered a grid that was mostly zeros, because the checks it counts started
 * firing in the most recent week and the six before it carried 107 model
 * answers between them. A reader was asked to derive a direction from that.
 *
 * Now one card per check, because the comparison a reader wants is this week
 * against before, per check, not week against week across seven columns. That
 * also stops the layout collapsing on a narrow screen, which a seven-column
 * table cannot avoid.
 *
 * The effect tag is the part that matters most. "Blocked" means the answer a
 * person read was changed or the input never reached it. "Recorded" means an
 * audit row was written and the answer was delivered unchanged. The previous
 * panel called both of these "stopped before a person saw it", which was true
 * of three checks and false of the rest.
 * ------------------------------------------------------------------------- */

const TREND_LABEL: Record<SignalTrend, string> = {
  up: "Higher than before",
  down: "Lower than before",
  flat: "Unchanged",
  "no-baseline": "No earlier result",
  insufficient: "Not enough traffic",
};

/* Deliberately NOT green-for-down. On this panel a falling catch rate is not
   automatically good news: it is also what a check that stopped running looks
   like. Every trend renders neutral and the sentence underneath carries the
   meaning, which is the only way to say "this rose, and that is the gate
   working" without the colour contradicting it. */
const TREND_TONE: Record<SignalTrend, SeverityTone> = {
  up: "info",
  down: "info",
  flat: "neutral",
  "no-baseline": "neutral",
  insufficient: "neutral",
};

/* One decimal at every magnitude. A column that switches precision by size
   reads as two different measurements, and "n/a" rather than "0.0" keeps a
   week nobody checked from looking like a clean one. */
function rateLabel(r: number | null): string {
  return r === null ? "n/a" : r.toFixed(1);
}

function QualityPanelBody({ weeks }: { weeks: QualityWeek[] }) {
  const summary = summariseQuality(weeks);

  return (
    <div data-testid="router-quality-panel">
      <p data-testid="router-quality-verdict" style={{ margin: "0 0 1rem", lineHeight: 1.5 }}>
        {summary.verdict}
      </p>

      <ul style={list}>
        {summary.signals.map((sig) => (
          <li key={sig.key} style={row} data-testid={`router-quality-signal-${sig.key}`}>
            <div
              style={{
                display: "flex",
                gap: "0.6rem",
                alignItems: "baseline",
                flexWrap: "wrap",
                justifyContent: "space-between",
              }}
            >
              <span style={{ fontWeight: 600 }}>{sig.label}</span>
              <span style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
                {/* What actually happened to the answer, said on every row so
                    no reader has to infer it from the wording of the label. */}
                <StatusPill
                  status={sig.effect}
                  tone={sig.effect === "blocked" ? "success" : "neutral"}
                  label={
                    sig.effect === "blocked"
                      ? "Changed what was delivered"
                      : sig.effect === "recorded"
                        ? "Logged, answer still delivered"
                        : "Volume, not a catch"
                  }
                  size="sm"
                />
                <StatusPill
                  status={sig.trend}
                  tone={TREND_TONE[sig.trend]}
                  label={TREND_LABEL[sig.trend]}
                  size="sm"
                  testId={`router-quality-trend-${sig.key}`}
                />
              </span>
            </div>

            <div
              style={{
                display: "flex",
                gap: "1.5rem",
                flexWrap: "wrap",
                margin: "0.55rem 0 0",
                fontSize: "0.9rem",
              }}
            >
              <span>
                <strong>{sig.latest.toLocaleString()}</strong>
                <span style={dim}>
                  {" "}
                  this week ({rateLabel(sig.latestRate)} per 1,000)
                </span>
              </span>
              <span>
                <strong>{sig.prior.toLocaleString()}</strong>
                <span style={dim}>
                  {" "}
                  in the {weeks.length - 1} weeks before ({rateLabel(sig.priorRate)} per 1,000)
                </span>
              </span>
            </div>

            <p style={{ ...dim, margin: "0.4rem 0 0", lineHeight: 1.5 }}>{sig.reading}</p>
          </li>
        ))}
      </ul>

      <p style={{ ...dim, margin: "0.9rem 0 0", fontSize: "0.82rem", lineHeight: 1.5 }}>
        Measured against {summary.latestVolume.toLocaleString()} model answers in the week of{" "}
        {summary.latestWeek} and {summary.priorVolume.toLocaleString()} before it. Rates are per
        1,000 model answers; a rate over a week with no model answers reads n/a rather than 0, because
        a zero in a column of rates reads as a clean week to anyone scanning it, and that is exactly
        the week nothing was checked.
      </p>
    </div>
  );
}

const dim: React.CSSProperties = { color: "var(--wp-text-dim)", fontSize: "0.9rem" };
const list: React.CSSProperties = { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.55rem" };
const row: React.CSSProperties = {
  border: "1px solid var(--wp-border, rgba(255,255,255,0.1))",
  borderRadius: "0.6rem",
  padding: "0.65rem 0.8rem",
};
const button: React.CSSProperties = {
  background: "var(--wp-accent, rgba(255,255,255,0.12))",
  color: "var(--wp-text, #fff)",
  border: "1px solid var(--wp-border, rgba(255,255,255,0.2))",
  borderRadius: "0.5rem",
  padding: "0.5rem 0.9rem",
  cursor: "pointer",
  fontSize: "0.9rem",
};
/* The refusal list. Built from the same tokens as `list`/`row` above rather
   than new colours: this panel is evidence in a console, not a callout. */
const ruleList: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: "0.9rem 0 0",
  display: "flex",
  flexDirection: "column",
  gap: "0.55rem",
};
const ruleItem: React.CSSProperties = {
  border: "1px solid var(--wp-border, rgba(255,255,255,0.1))",
  borderRadius: "0.6rem",
  padding: "0.65rem 0.8rem",
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
};
const ruleHead: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  fontSize: "0.95rem",
  color: "var(--wp-text, #fff)",
};
const ruleCount: React.CSSProperties = {
  fontVariantNumeric: "tabular-nums",
  color: "var(--wp-text-dim)",
  fontSize: "0.85rem",
};
const ruleWhy: React.CSSProperties = {
  fontSize: "0.85rem",
  lineHeight: 1.5,
  color: "var(--wp-text-dim)",
};
const notice: React.CSSProperties = {
  marginTop: "0.9rem",
  fontSize: "0.85rem",
  color: "var(--wp-text-dim)",
  borderLeft: "2px solid var(--wp-border, rgba(255,255,255,0.2))",
  paddingLeft: "0.7rem",
};
