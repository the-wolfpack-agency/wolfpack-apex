/**
 * Enforces: every module that calls a model either routes the content it did
 * not write through the provenance fence (src/lib/ai/provenance.ts), or is on
 * the reviewed allowlist below with the reason it does not need to.
 *
 * WHY. Indirect prompt injection arrives in content the system fetched on a
 * person's behalf: an inbound email, a meeting thread, a CRM note, a web page,
 * an uploaded file, a tool's result. The fence quarantines that content as
 * data. It only protects the call sites that use it, and for most of the
 * product's life only the assistant did, while the support auto-acknowledge
 * path read a stranger's email and mailed the model's answer back to them.
 * This test is the permanent guardrail, modeled on no-raw-api-fetch.test.ts:
 * a new model call site fails the build until someone decides how it handles
 * outside content.
 *
 * WHAT COUNTS AS A MODEL CALL SITE. A non-test module under src/ that calls
 * the router (`getAIClient(`), the Anthropic Messages API directly, or an SDK
 * `.messages.create(`. A module counts as FENCED when it uses fenceUntrusted,
 * fenceForPrompt, interpolateFenced, buildFencedExtractionPrompt, or (for a
 * file sent as a typed image/document block, which a text fence cannot wrap)
 * ATTACHED_FILES_ARE_DATA.
 *
 * THE RULE IS STRICTER THAN "takes outside content": every call site must be
 * fenced or explained. Guessing whether a module reads outside content from
 * its text would be a heuristic that goes quiet exactly when it matters.
 *
 * ALLOWLIST KINDS
 *   provider        implements the model client itself; carries no prompt.
 *   caller-authored the prompt is the authenticated caller's own words (and
 *                   our fixed text); no third party's text is concatenated.
 *   transport       sends a prompt another module builds; the builders are
 *                   named and THIS TEST CHECKS THEY ARE FENCED.
 *   instrument      deliberately unguarded measurement; reason says why it is
 *                   contained.
 */
import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(ROOT, "src");

const MODEL_CALL = /getAIClient\(|api\.anthropic\.com\/v1\/messages|\.messages\.create\(/;
const FENCE =
  /\bfenceUntrusted\(|\bfenceForPrompt\(|\binterpolateFenced\(|\bbuildFencedExtractionPrompt\(|\bATTACHED_FILES_ARE_DATA\b/;

type Entry =
  | { kind: "provider" | "caller-authored" | "instrument"; reason: string }
  | { kind: "transport"; reason: string; builders: string[] };

const ALLOWLIST: Record<string, Entry> = {
  "src/lib/ai/router.ts": { kind: "provider", reason: "defines getAIClient; routes requests, builds no prompt" },
  "src/lib/ai/types.ts": { kind: "provider", reason: "type declarations; getAIClient appears in a doc comment" },
  "src/lib/ai/anthropic-provider.ts": { kind: "provider", reason: "the Anthropic provider behind the router" },

  "src/app/api/gate/complete/route.ts": {
    kind: "caller-authored",
    reason: "pass-through completion for an authenticated outside agent: the agent is the principal and its prompt is its own instruction",
  },
  "src/app/api/admin/ai-code/plan/route.ts": {
    kind: "caller-authored",
    reason: "admin-only; goal and context are typed by the operator",
  },
  "src/lib/ai-code/plan.ts": { kind: "caller-authored", reason: "composePlanPrompt(goal, context): the operator's own words" },
  "src/lib/ai-code/author.ts": {
    kind: "caller-authored",
    reason: "the operator's build prompt plus our gate feedback; output is gated by AgentGate, CI and a human merge",
  },
  "src/lib/ai/a2a-proof.ts": {
    kind: "caller-authored",
    reason: "agent A's composed prompt to agent B; getAIClient appears in a comment; the judging step is fenced in src/lib/ai/judge.ts",
  },
  "src/lib/assistant/routines/sweep.ts": {
    kind: "caller-authored",
    reason: "repair prompt is the routine author's step label, our own problem text and the tool manifest; the answer is checked against the live registry and saved only on the person's yes",
  },
  "src/lib/brain/expand-runner.ts": { kind: "caller-authored", reason: "rewrites the signed-in person's own question" },
  "src/lib/claude-report-generator.ts": {
    kind: "caller-authored",
    reason: "the operator's report description, client name and notes, typed in the report builder",
  },

  "src/app/api/admin/ai-code/pipeline/route.ts": {
    kind: "transport",
    reason: "authors from the operator's prompt; the steps that read a diff or CI output are built in the fenced builders",
    builders: ["src/lib/ai-code/repair.ts", "src/lib/ai-code/judge.ts", "src/lib/ai-code/ci-failure-detail.ts"],
  },
  "src/lib/ai-code/ci-fix-runner.ts": {
    kind: "transport",
    reason: "sends buildEnrichedFixPrompt (CI output + repo files)",
    builders: ["src/lib/ai-code/ci-failure-detail.ts"],
  },
  "src/app/api/gate/[gate]/route.ts": {
    kind: "transport",
    reason: "the GateAgent adapter; the only gate that calls the model builds its prompt with buildEnrichedFixPrompt",
    builders: ["src/lib/ai-code/ci-failure-detail.ts"],
  },
  "src/lib/automations/meeting-insights/analyzer/anthropic.ts": {
    kind: "transport",
    reason: "SDK transport; the email/transcript prompt is built and fenced in analyzer/index.ts",
    builders: ["src/lib/automations/meeting-insights/analyzer/index.ts"],
  },
  "src/lib/brain/ingest.ts": {
    kind: "transport",
    reason: "sends summarizeDocument's prompt; the document is fenced in enrich.ts",
    builders: ["src/lib/brain/enrich.ts"],
  },

  "src/lib/assistant/routines/index.ts": {
    kind: "transport",
    reason: "liveDeps.askModel sends the prompt the runner built with every slot value fenced (interpolateFenced), and reports the attempts it found",
    builders: ["src/lib/assistant/routines/runner.ts"],
  },

  "src/app/api/admin/agent-probe/run/route.ts": {
    kind: "instrument",
    reason: "admin-only red-team probe that runs a deliberately unguarded agent against our own deception grid to measure what an unprotected agent does; fencing would falsify the measurement. Origin-pinned by agent-probe-runner (the model only picks paths), size and time bounded, and no send, write or tool is reachable from its output",
  },
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const rel = (abs: string) => path.relative(ROOT, abs).split(path.sep).join("/");
const read = (r: string) => fs.readFileSync(path.join(ROOT, r), "utf-8");

/* Detector corpora and scanners hold these strings as DATA (patterns they
   look for in other people's code), never as calls. Skipped by directory so a
   new scanner fixture does not need an allowlist line. */
const DATA_ONLY_DIRS = [
  "src/lib/platform-scan/",
  "src/lib/containment/",
  "src/lib/forcefield/",
  "src/lib/forcefield-web/ruleset.ts",
  "src/lib/ogiam/demo-seed.ts",
];

describe("every model call site fences outside content or is explained", () => {
  const callSites = walk(SRC)
    .map(rel)
    .filter((r) => !DATA_ONLY_DIRS.some((d) => r.startsWith(d)))
    .filter((r) => MODEL_CALL.test(read(r)));

  it("finds the call sites (the scan is not silently empty)", () => {
    expect(callSites.length).toBeGreaterThan(10);
    expect(callSites).toContain("src/lib/support/auto-acknowledge.ts");
  });

  it("forbids a model call site that neither fences nor is allowlisted", () => {
    const offenders = callSites.filter((r) => !FENCE.test(read(r)) && !(r in ALLOWLIST));
    expect(
      offenders.map(
        (r) =>
          `${r} calls a model without the provenance fence. Route email, meeting, web, file or tool content through fenceUntrusted / fenceForPrompt (src/lib/ai/fence-report.ts), or add a reviewed ALLOWLIST entry saying why it takes none.`,
      ),
    ).toEqual([]);
  });

  it("keeps the four paths that read strangers' content fenced", () => {
    for (const r of [
      "src/lib/support/auto-acknowledge.ts",
      "src/lib/insights/meeting-prep-synthesize.ts",
      "src/lib/assistant/tools/plan-my-day-tool.ts",
    ]) {
      expect(r in ALLOWLIST).toBe(false);
      expect(FENCE.test(read(r))).toBe(true);
    }
    /* Routines: the call site is a transport for the runner, which fences
       every slot value; the call site reports what the fence found. */
    expect(ALLOWLIST["src/lib/assistant/routines/index.ts"]?.kind).toBe("transport");
    expect(read("src/lib/assistant/routines/index.ts")).toMatch(/reportFenceAttempts\(/);
    /* The routine runner and the day-plan builder do the fencing those two use. */
    expect(read("src/lib/assistant/routines/runner.ts")).toMatch(/interpolateFenced\(/);
    expect(read("src/lib/assistant/routines/day-plan.ts")).toMatch(/fenceUntrusted\(/);
  });

  it("checks that every transport's named builders are themselves fenced", () => {
    const unfenced: string[] = [];
    for (const [file, entry] of Object.entries(ALLOWLIST)) {
      if (entry.kind !== "transport") continue;
      for (const b of entry.builders) {
        if (!fs.existsSync(path.join(ROOT, b)) || !FENCE.test(read(b))) unfenced.push(`${file} -> ${b}`);
      }
    }
    expect(unfenced).toEqual([]);
  });

  it("has no stale allowlist entry", () => {
    const stale = Object.keys(ALLOWLIST).filter(
      (r) => !fs.existsSync(path.join(ROOT, r)) || !MODEL_CALL.test(read(r)) || FENCE.test(read(r)),
    );
    expect(stale.map((r) => `${r} is no longer an unfenced model call site; remove it from ALLOWLIST`)).toEqual([]);
  });

  it("gives every allowlist entry a reason", () => {
    for (const [r, entry] of Object.entries(ALLOWLIST)) {
      expect(`${r}: ${entry.reason}`.length).toBeGreaterThan(r.length + 20);
    }
  });
});
