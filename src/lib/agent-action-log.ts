/**
 * Agent action log - the case file. Turns the ordered, timestamped trace
 * (JourneyStep[]) into a plain-language narrative a non-technical reader can
 * follow like a police report: what the agent did before the incident, the
 * hostile act itself, and what it did afterward. Same data as the visual path
 * chain; this adds the human sentence, the clock, and the phase.
 *
 * Pure + deterministic + client-safe (types only): the component renders it, a
 * test pins the language. No PII - paths and signals only.
 */
import type { JourneyStep } from "@/lib/agent-behavior";

export type ActionPhase = "lead_up" | "hostile_act" | "aftermath";
export type ActionSeverity = "good" | "info" | "notice" | "hostile";

export interface ActionLogEntry {
  at: string;
  /** Wall clock HH:MM:SS (UTC). */
  clock: string;
  /** Short date, e.g. "20 Sep 2026" (UTC). Shown when the day changes so a
   *  multi-day journey is never ambiguous. */
  date: string;
  /** Stable day key (YYYY-MM-DD, UTC) for detecting a day change between steps. */
  dayKey: string;
  /** Elapsed since the previous step, e.g. "+4s" / "+2m" ("start" for the first). */
  delta: string;
  phase: ActionPhase;
  severity: ActionSeverity;
  /** Two-word label, e.g. "Probed sensitive". */
  headline: string;
  /** One plain sentence a non-expert understands. */
  detail: string;
  path: string;
}

interface Descriptor {
  headline: string;
  severity: ActionSeverity;
  detail: (path: string, attack?: string) => string;
}

/** Signal -> plain language. The detail speaks to a human, not an engineer. */
const DESCRIBE: Record<string, Descriptor> = {
  visit: { headline: "Visited", severity: "info", detail: (p) => `Browsed to ${p}.` },
  read_robots: { headline: "Read the rules", severity: "info", detail: () => "Read robots.txt - the file that tells bots which areas are off-limits. Good crawlers check it first." },
  read_sitemap: { headline: "Read the sitemap", severity: "info", detail: () => "Pulled the sitemap to see every page at once." },
  identified_agent: { headline: "Identified itself", severity: "good", detail: (p) => `Announced itself as a known, recognized crawler when it reached ${p}.` },
  high_rate: { headline: "Rapid requests", severity: "notice", detail: () => "Fired requests faster than a person browsing - automated speed." },
  form_too_fast: { headline: "Instant submit", severity: "notice", detail: (p) => `Submitted the form at ${p} faster than a human could type it - a bot filling it in.` },
  probed_sensitive: { headline: "Probed sensitive", severity: "hostile", detail: (p) => `Poked at ${p} - a login, admin, or config path. It was looking for a way in.` },
  id_enumeration: { headline: "Walked IDs", severity: "hostile", detail: (p) => `Stepped through record IDs in order near ${p}, fishing for data it should not be able to reach.` },
  runaway_loop: { headline: "Hammered endpoint", severity: "notice", detail: (p) => `Hit ${p} over and over in a tight loop - resource abuse, not normal use.` },
  tripped_decoy: { headline: "Took the bait", severity: "hostile", detail: (p) => `Followed an invisible trap link to ${p} that a real person can never see. Only an automated scraper walking every link finds it.` },
  form_honeypot: { headline: "Hidden field", severity: "hostile", detail: (p) => `Filled a hidden form field at ${p} that is invisible to humans - a dead giveaway of a bot.` },
  payload_attack: { headline: "Live attack", severity: "hostile", detail: (p, attack) => `Fired a live ${(attack ?? "injection").replace(/_/g, " ")} attack at ${p} - an actual attempt to exploit the page, not just looking around.` },
};

function clockOf(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "--:--:--";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dateOf(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
function dayKeyOf(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function deltaOf(prevIso: string | null, iso: string): string {
  if (!prevIso) return "start";
  const a = Date.parse(prevIso);
  const b = Date.parse(iso);
  if (Number.isNaN(a) || Number.isNaN(b)) return "";
  const s = Math.max(0, Math.round((b - a) / 1000));
  if (s < 60) return `+${s}s`;
  if (s < 3600) return `+${Math.round(s / 60)}m`;
  return `+${Math.round(s / 3600)}h`;
}

function descriptorFor(step: JourneyStep): Descriptor {
  return (step.signal && DESCRIBE[step.signal]) || DESCRIBE.visit;
}

/**
 * Build the plain-language, phased case file from a journey's steps. Phases form
 * contiguous bands around the incident: everything before the FIRST hostile act
 * is the lead-up; the window from the first through the last hostile act is the
 * incident; everything after is the aftermath. With no hostile act, it is all
 * lead-up (the component labels that "Activity").
 */
export function buildActionLog(steps: readonly JourneyStep[]): ActionLogEntry[] {
  if (!steps || steps.length === 0) return [];
  const sev = steps.map((s) => descriptorFor(s).severity);
  const firstHostile = sev.findIndex((x) => x === "hostile");
  const lastHostile = firstHostile === -1 ? -1 : sev.lastIndexOf("hostile");

  const out: ActionLogEntry[] = [];
  let prevIso: string | null = null;
  steps.forEach((step, i) => {
    const d = descriptorFor(step);
    const phase: ActionPhase =
      firstHostile === -1 || i < firstHostile ? "lead_up" : i > lastHostile ? "aftermath" : "hostile_act";
    out.push({
      at: step.at,
      clock: clockOf(step.at),
      date: dateOf(step.at),
      dayKey: dayKeyOf(step.at),
      delta: deltaOf(prevIso, step.at),
      phase,
      severity: d.severity,
      headline: d.headline,
      detail: d.detail(step.path || "the site", step.attack),
      path: step.path,
    });
    prevIso = step.at;
  });
  return out;
}

/** Human phase labels for the case-file section headers. */
export const PHASE_LABEL: Record<ActionPhase, string> = {
  lead_up: "Lead-up",
  hostile_act: "The hostile action",
  aftermath: "Afterward",
};

/** A focused view item: either a single kept entry, or a collapsed run of
 *  consecutive routine (good/info) steps that carry no key signal. */
export type ActionLogGroup =
  | { kind: "entry"; entry: ActionLogEntry; index: number }
  | { kind: "collapsed"; entries: ActionLogEntry[]; from: number; count: number; summary: string };

/** An entry is KEY (always shown) when it is the hostile action or a rapid/loop
 *  notice, the first or last step, or the step where the phase changes. Only runs
 *  of consecutive NON-key routine steps are eligible to collapse. */
function isKeyEntry(entries: readonly ActionLogEntry[], i: number): boolean {
  const e = entries[i];
  if (e.severity === "hostile" || e.severity === "notice") return true;
  if (i === 0 || i === entries.length - 1) return true;
  if (e.phase !== entries[i - 1].phase) return true;
  return false;
}

/** One-line summary for a collapsed run, e.g. "12 routine steps (mostly Visited)". */
function summarizeRun(run: readonly ActionLogEntry[]): string {
  const counts = new Map<string, number>();
  for (const e of run) counts.set(e.headline, (counts.get(e.headline) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "routine";
  return `${run.length} routine step${run.length === 1 ? "" : "s"} (mostly ${top})`;
}

/**
 * Collapse a case file to its signal: keep every key step (hostile act, rapid/loop
 * notice, first, last, phase change) and fold each run of >= `collapseThreshold`
 * consecutive routine steps into ONE expandable summary. A long "hammered one
 * endpoint in a loop" trail becomes a few key rows plus "N routine steps", instead
 * of pages of identical "Visited" lines. Short runs stay inline (not worth a fold).
 */
export function focusActionLog(entries: readonly ActionLogEntry[], collapseThreshold = 3): ActionLogGroup[] {
  const out: ActionLogGroup[] = [];
  let run: ActionLogEntry[] = [];
  let runStart = 0;
  const flush = () => {
    if (run.length === 0) return;
    if (run.length >= collapseThreshold) {
      out.push({ kind: "collapsed", entries: run, from: runStart, count: run.length, summary: summarizeRun(run) });
    } else {
      run.forEach((entry, k) => out.push({ kind: "entry", entry, index: runStart + k }));
    }
    run = [];
  };
  entries.forEach((entry, i) => {
    if (isKeyEntry(entries, i)) {
      flush();
      out.push({ kind: "entry", entry, index: i });
    } else {
      if (run.length === 0) runStart = i;
      run.push(entry);
    }
  });
  flush();
  return out;
}
