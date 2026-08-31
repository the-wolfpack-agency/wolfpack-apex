"use client";

/**
 * Your routines, and what they are costing you.
 *
 * WHY THIS PAGE EXISTS
 *
 * Everything on it was already being recorded and could only be reached by
 * asking the assistant. That is fine for "run my morning" and useless for the
 * question this product is actually trying to answer, which is whether any of
 * it is improving somebody's day. That question needs a page, because it is
 * answered by a shape over time rather than by a sentence.
 *
 * THE INSIGHT IS THE POINT, AND IT GOES ABOVE THE HISTORY
 *
 * A list of runs is a log. The findings underneath are a log with a conclusion
 * attached: this step is not happening, this one is expensive enough to be
 * worth a tool, this pause is not earning its place. Somebody who reads only
 * the top of this page should still leave with something they can act on.
 *
 * Nothing here is about anybody else. Every row is the caller's own, which is
 * what lets a page describing how a person spends their day exist at all.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, fetchWithRefresh } from "@/lib/client-auth";
import { GlassPanel, MetricTile, SectionHeader, ConsoleGrid, StatusPill } from "@/components/console";
import type { SeverityTone } from "@/components/console/severity";

interface RoutineSummary {
  command: string;
  description: string;
  steps: number;
  humanSteps: number;
  /* The steps it WOULD run. Absent from an older response rather than
     empty, so the page can tell "this chain has no steps" from "this
     deployment does not send them yet" and stay quiet in the second
     case. */
  plan?: PlanStep[];
}

interface AreaMap {
  summary: string;
  areas: Array<{ area: string; forRole: string; chains: Array<{ command: string; touches: string[]; humanSteps: number }> }>;
  crossings: Array<{ tool: string; areas: string[]; chains: string[] }>;
}

interface ScheduleSummary {
  command: string;
  when: string;
  nextRunAt: string;
}

/**
 * One step as it was recorded, which is the whole point of this view.
 *
 * A run used to be one line saying how many steps it had. That answers
 * "did it work" and nothing else. Somebody deciding whether to trust a
 * chain with their morning wants to see WHICH systems it touched, in what
 * order, and where it stopped for them, and that is a different question
 * from a count.
 */
/** A step of a chain that has NOT run: no duration, nothing happened. */
interface PlanStep {
  index: number;
  kind: string;
  tool: string | null;
  label: string;
}

interface RunStep {
  index: number;
  kind: string;
  tool: string | null;
  label: string;
  status: string;
  durationMs: number;
  error: string | null;
  humanAction: string | null;
}

interface RunSummary {
  runId: string;
  routineId: string;
  state: string;
  startedAt: string;
  techMs: number;
  humanMs: number;
  steps: number;
  waitingOn: string | null;
}

interface Finding {
  routineId: string;
  stepIndex: number;
  label: string;
  kind: "not_happening" | "worth_a_tool" | "pause_not_earning" | "healthy";
  observation: string;
  suggestion: string;
  completionRate: number;
}

interface Payload {
  builtIn: RoutineSummary[];
  areaMap?: AreaMap;
  saved: RoutineSummary[];
  schedules: ScheduleSummary[];
  runs: RunSummary[];
  findings: Finding[];
}

/** Minutes, because milliseconds are a unit nobody feels. */
function mins(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${Math.round(ms / 60_000)}m`;
}

/* Tones from the shared severity scale, not new colors. "Not happening" is a
   warning rather than an error on purpose: a step somebody skipped is
   information about the routine, and coloring it red would make the page feel
   like an assessment of the person reading it. */
const FINDING_TONE: Record<Finding["kind"], { label: string; tone: SeverityTone }> = {
  not_happening: { label: "Not happening", tone: "warning" },
  worth_a_tool: { label: "Worth a tool", tone: "info" },
  pause_not_earning: { label: "Pause not earning", tone: "info" },
  healthy: { label: "Working", tone: "success" },
};

export default function RoutinesPage() {
  const router = useRouter();
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/routines");
      if (!res.ok) {
        setError("Your routines could not be read just now.");
        return;
      }
      const body = (await res.json()) as Partial<Payload>;
      /* Field by field, so a payload from an older deploy renders rather than
         throwing and blanking the page during the minute of a rollout. */
      setData({
        builtIn: Array.isArray(body.builtIn) ? body.builtIn : [],
        areaMap: body.areaMap,
        saved: Array.isArray(body.saved) ? body.saved : [],
        schedules: Array.isArray(body.schedules) ? body.schedules : [],
        runs: Array.isArray(body.runs) ? body.runs : [],
        findings: Array.isArray(body.findings) ? body.findings : [],
      });
    } catch {
      setError("Your routines could not be read just now.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Redirect unauthenticated users; never render a blank state.
    if (!getInstinctUser<{ role: string }>()) {
      router.push("/login?next=/routines");
      return;
    }
    void load();
  }, [router, load]);

  /* Fetched per run, on demand, and kept once fetched.
     The list can hold twenty runs and nobody opens twenty. Loading every
     run's steps to render a page where most of them stay closed would
     make the page slower for everybody to serve the person who opens one,
     and the steps of a finished run do not change. */
  /* Which chain's plan is open. Separate from the run state below: a
     person comparing what a chain WOULD do against what it DID is looking
     at two different things and should not have one close the other. */
  const [openPlan, setOpenPlan] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [steps, setSteps] = useState<Record<string, RunStep[]>>({});

  const toggleRun = useCallback(
    async (runId: string) => {
      if (openRun === runId) {
        setOpenRun(null);
        return;
      }
      setOpenRun(runId);
      if (steps[runId] !== undefined) return;
      try {
        const res = await fetchWithRefresh(`/api/routines/${encodeURIComponent(runId)}/steps`);
        const body = await res.json();
        setSteps((prev) => ({
          ...prev,
          [runId]: Array.isArray(body.steps) ? body.steps : [],
        }));
      } catch {
        /* An empty list reads as "no steps recorded", which is honest when
           we could not read them and is better than a panel that stays on
           "reading" forever. */
        setSteps((prev) => ({ ...prev, [runId]: [] }));
      }
    },
    [openRun, steps],
  );

  const waiting = (data?.runs ?? []).filter((r) => r.state === "waiting_for_human");
  const humanTotal = (data?.runs ?? []).reduce((n, r) => n + r.humanMs, 0);
  const techTotal = (data?.runs ?? []).reduce((n, r) => n + r.techMs, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }} data-testid="routines-root">
      <SectionHeader
        as="h1"
        eyebrow="Assistant"
        title="Your routines"
        subtitle="Chains you can run with one command, what runs on its own, and where your own time is going."
      />

      {loading ? (
        <p data-testid="routines-loading" style={dim}>
          Checking…
        </p>
      ) : error ? (
        <p data-testid="routines-error" style={dim}>
          {error}
        </p>
      ) : null}

      {data ? (
        <>
          {/* WAITING FIRST. Anything else on this page is information; this is
              somebody being held up, and it is the only row that is a request. */}
          {waiting.length > 0 ? (
            <GlassPanel
              title="Waiting on you"
              subtitle="These ran and stopped at a step only you can do."
            >
              <ul style={list} data-testid="routines-waiting">
                {waiting.map((r) => (
                  <li key={r.runId} style={row}>
                    <strong>{r.routineId}</strong>
                    <span style={dim}> {r.waitingOn ?? "is waiting for you"}</span>
                  </li>
                ))}
              </ul>
            </GlassPanel>
          ) : null}

          <ConsoleGrid>
            <MetricTile
              value={data.saved.length + data.builtIn.length}
              label="Chains available"
              kicker="Type the command to run one"
              testId="routines-metric-chains"
            />
            <MetricTile
              value={data.schedules.length}
              label="Running on their own"
              kicker="Each still stops for you"
              testId="routines-metric-scheduled"
            />
            {/* THE TWO NUMBERS KEPT APART, here as everywhere. Added together
                they would say nothing; apart they say what the machine carried
                and what you still carry. */}
            <MetricTile
              value={Math.round(techTotal / 60_000)}
              label="Minutes of work done for you"
              kicker="Across your recent runs"
              testId="routines-metric-tech"
            />
            <MetricTile
              value={Math.round(humanTotal / 60_000)}
              label="Minutes of your own time"
              kicker="At the steps only you can do"
              testId="routines-metric-human"
            />
          </ConsoleGrid>

          {/* THE CONCLUSION, ABOVE THE LOG. Somebody who reads only the top of
              this page should still leave with something they can act on. */}
          <GlassPanel
            title="What your own steps are telling you"
            subtitle="Read from your runs. Every line is about a step, never about you."
          >
            {data.findings.length === 0 ? (
              <p style={dim} data-testid="routines-no-findings">
                Not enough runs yet to say anything useful. This fills in once a routine with a step of
                your own has run a handful of times, and it stays quiet until then rather than reading
                something into one morning.
              </p>
            ) : (
              <ul style={list} data-testid="routines-findings">
                {data.findings.map((f) => (
                  <li key={`${f.routineId}:${f.stepIndex}`} style={row}>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.3rem" }}>
                      <StatusPill
                        status={f.kind}
                        label={FINDING_TONE[f.kind]?.label ?? f.kind}
                        tone={FINDING_TONE[f.kind]?.tone ?? "info"}
                        size="sm"
                      />
                      <strong>{f.label}</strong>
                    </div>
                    <div style={dim}>{f.observation}</div>
                    <div style={{ ...dim, marginTop: "0.25rem" }}>{f.suggestion}</div>
                  </li>
                ))}
              </ul>
            )}
          </GlassPanel>

          {data.areaMap && data.areaMap.areas.length > 0 ? (
            <GlassPanel
              title="Who these are for, and where they meet"
              subtitle={data.areaMap.summary}
            >
              <ul style={list} data-testid="routines-areas">
                {data.areaMap.areas.map((a) => (
                  <li key={a.area} style={row}>
                    <strong style={{ textTransform: "capitalize" }}>{a.area}</strong>
                    <span style={dim}> {a.forRole}</span>
                    <div style={dim}>
                      {a.chains.map((c) => c.command).join(" · ")}
                    </div>
                  </li>
                ))}
              </ul>

              {data.areaMap.crossings.length > 0 ? (
                <>
                  {/* The part a list of chains cannot show: one area's
                      work reaching another's. Named with the chains
                      involved, so it can be checked rather than
                      believed. */}
                  <p style={{ ...dim, margin: "0.9rem 0 0.4rem" }}>
                    Systems more than one area reaches, most shared first. These are the
                    connections worth making early, and the ones worth worrying about when
                    they are down.
                  </p>
                  <ul style={list} data-testid="routines-crossings">
                    {data.areaMap.crossings.slice(0, 8).map((c) => (
                      <li key={c.tool} style={row}>
                        <code>{c.tool}</code>
                        <span style={dim}> {c.areas.join(" and ")}</span>
                        <div style={dim}>{c.chains.join(" · ")}</div>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p style={{ ...dim, marginTop: "0.9rem" }} data-testid="routines-no-crossings">
                  No system is reached from more than one area yet, so nothing here shows one
                  area&apos;s work reaching another&apos;s.
                </p>
              )}
            </GlassPanel>
          ) : null}

          <GlassPanel title="Chains you can run" subtitle="Type the command anywhere in the assistant.">
            <ul style={list} data-testid="routines-chains">
              {[...data.saved, ...data.builtIn].map((r) => (
                <li key={r.command} style={row}>
                  <button
                    type="button"
                    onClick={() => setOpenPlan((cur) => (cur === r.command ? null : r.command))}
                    aria-expanded={openPlan === r.command}
                    data-testid="routines-plan-toggle"
                    style={runButton}
                  >
                    <strong>{r.command}</strong>
                    <div style={dim}>{r.description}</div>
                    <div style={dim}>
                      {r.steps} {r.steps === 1 ? "step" : "steps"}
                      {r.humanSteps > 0
                        ? `, ${r.humanSteps} of them yours`
                        : ", none of them yours"}
                      {" · "}
                      {openPlan === r.command ? "hide what it does" : "see what it does"}
                    </div>
                  </button>

                  {openPlan === r.command && (r.plan ?? []).length > 0 ? (
                    <ol style={tiles} data-testid="routines-plan-steps">
                      {(r.plan ?? []).map((st) => (
                        <li key={st.index} style={tile} data-testid="routines-plan-step">
                          <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                            <StatusPill
                              status={st.kind}
                              label={KIND_LABEL[st.kind] ?? st.kind}
                              tone={KIND_TONE[st.kind] ?? "info"}
                              size="sm"
                            />
                            <strong style={{ fontSize: "0.92rem" }}>{st.label}</strong>
                          </div>
                          {/* No duration: nothing has run. An estimate
                              here would be a number somebody plans around
                              that we invented. */}
                          <div style={{ ...dim, marginTop: "0.3rem" }}>
                            {st.tool ? (
                              <code>{st.tool}</code>
                            ) : st.kind === "human" ? (
                              "waits for you"
                            ) : (
                              "no system touched"
                            )}
                          </div>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </li>
              ))}
            </ul>
          </GlassPanel>

          <GlassPanel
            title="Running on their own"
            subtitle="A scheduled run gathers and then waits for you. Nothing is sent or filed without you confirming it."
          >
            {data.schedules.length === 0 ? (
              <p style={dim} data-testid="routines-no-schedules">
                Nothing runs automatically yet. Say “run my morning every weekday at 8am” in the
                assistant and it will start meeting you.
              </p>
            ) : (
              <ul style={list} data-testid="routines-schedules">
                {data.schedules.map((s) => (
                  <li key={s.command} style={row}>
                    <strong>{s.command}</strong>
                    <span style={dim}> {s.when}</span>
                  </li>
                ))}
              </ul>
            )}
          </GlassPanel>

          <GlassPanel title="Recent runs" subtitle="Newest first.">
            {data.runs.length === 0 ? (
              <p style={dim} data-testid="routines-no-runs">
                Nothing has run yet.
              </p>
            ) : (
              <ul style={list} data-testid="routines-runs">
                {data.runs.map((r) => (
                  <li key={r.runId} style={row}>
                    <button
                      type="button"
                      onClick={() => void toggleRun(r.runId)}
                      aria-expanded={openRun === r.runId}
                      data-testid="routines-run-toggle"
                      style={runButton}
                    >
                      <strong>{r.routineId}</strong>
                      <span style={dim}>
                        {" "}
                        {r.startedAt.slice(0, 10)}, {r.steps} {r.steps === 1 ? "step" : "steps"},{" "}
                        {mins(r.techMs)} of work
                        {r.humanMs > 0 ? ` and ${mins(r.humanMs)} of yours` : ""}
                      </span>
                      <div style={dim}>
                        {r.state.replace(/_/g, " ")}
                        {" · "}
                        {openRun === r.runId ? "hide the steps" : "see the steps"}
                      </div>
                    </button>

                    {openRun === r.runId ? (
                      steps[r.runId] === undefined ? (
                        <p style={{ ...dim, marginTop: "0.6rem" }}>Reading the run…</p>
                      ) : steps[r.runId].length === 0 ? (
                        <p style={{ ...dim, marginTop: "0.6rem" }} data-testid="routines-run-no-steps">
                          No steps were recorded for this run.
                        </p>
                      ) : (
                        <ol style={tiles} data-testid="routines-run-steps">
                          {steps[r.runId].map((st) => (
                            <li key={st.index} style={tile} data-testid="routines-run-step">
                              <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                                <StatusPill
                                  status={st.kind}
                                  label={KIND_LABEL[st.kind] ?? st.kind}
                                  tone={KIND_TONE[st.kind] ?? "info"}
                                  size="sm"
                                />
                                <strong style={{ fontSize: "0.92rem" }}>{st.label}</strong>
                              </div>
                              {/* The tool is the answer to "what did it
                                  touch". Absent on model and human steps
                                  because they touched nothing, and saying
                                  so is more useful than leaving a gap. */}
                              <div style={{ ...dim, marginTop: "0.3rem" }}>
                                {st.tool ? <code>{st.tool}</code> : st.kind === "human" ? "your call" : "no system touched"}
                                {" · "}
                                {st.kind === "human" && st.durationMs > 0
                                  ? `${ms(st.durationMs)} of your time`
                                  : ms(st.durationMs)}
                                {st.status !== "ok" ? ` · ${st.status}` : ""}
                              </div>
                              {st.error ? (
                                <div style={{ ...dim, marginTop: "0.25rem" }}>{st.error}</div>
                              ) : null}
                            </li>
                          ))}
                        </ol>
                      )
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </GlassPanel>
        </>
      ) : null}
    </div>
  );
}

/* A step is one of three things and they are not the same kind of thing.
   A tool touched one of the client's systems, a model wrote something
   from what the tools returned, and a human step is the chain stopping
   and waiting. Showing them identically would hide the one distinction
   this product is built on. */
const KIND_LABEL: Record<string, string> = {
  tool: "system",
  model: "written",
  human: "you",
};
const KIND_TONE: Record<string, SeverityTone> = {
  tool: "info",
  model: "info",
  human: "warning",
};

function ms(n: number): string {
  if (n < 1000) return `${n}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n / 60_000)}m`;
}

const runButton: React.CSSProperties = {
  all: "unset",
  cursor: "pointer",
  display: "block",
  width: "100%",
};
/* Tiles rather than rows: the steps of a chain are a sequence somebody
   reads left to right and top to bottom, and they wrap on a phone into
   the same order they ran in. */
const tiles: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: "0.7rem 0 0",
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 15rem), 1fr))",
  gap: "0.5rem",
};
const tile: React.CSSProperties = {
  border: "1px solid var(--wp-border, rgba(255,255,255,0.1))",
  borderRadius: "0.55rem",
  padding: "0.6rem 0.7rem",
  background: "var(--wp-surface-2, rgba(255,255,255,0.02))",
};

const dim: React.CSSProperties = { color: "var(--wp-text-dim)", fontSize: "0.9rem" };
const list: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "flex",
  flexDirection: "column",
  gap: "0.55rem",
};
const row: React.CSSProperties = {
  border: "1px solid var(--wp-border, rgba(255,255,255,0.1))",
  borderRadius: "0.6rem",
  padding: "0.65rem 0.8rem",
};
