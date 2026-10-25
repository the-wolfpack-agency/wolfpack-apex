/**
 * Guard for the RLS cutover (docs/security/rls-cutover.md, prerequisite 2).
 *
 * Under the app role with INSTINCT_RLS_SESSION_CONTEXT=on, a statement on an
 * RLS-covered table with no context returns zero rows. A request gets its
 * context from requireCapability; a cron or sweep has none unless it sets one.
 * A cron that forgets does not error. It quietly stops doing its job.
 *
 * So every scheduled route that can reach a covered table (through its static
 * import graph) must be listed in CRON_CONTEXT with the file(s) where it sets
 * its context and why. The test checks each claim: the file is reachable from
 * the route, and the file really calls withSystemScope (system) or
 * runWithRequestWorkspace / withWorkspaceScope (workspace).
 *
 * And every sweep the tenant-isolation scanner classifies as
 * system-cross-workspace on a covered table must call withSystemScope.
 *
 * A NEW cron, or a cron that starts reaching a covered table, fails here until
 * it is given a context and listed. Prefer "workspace" (narrowest). Use
 * "system" only for the statement that genuinely enumerates across workspaces.
 */
import fs from "fs";
import os from "os";
import path from "path";
import {
  coveredTablesIn,
  cronReach,
  reachableFiles,
  rlsCoveredTables,
  runtimeImports,
  scheduledRoutes,
  setsContext,
  type ContextKind,
} from "@/lib/db/rls-context-scan";
import { scanRepo } from "@/lib/db/tenant-scope-scan";

const ROOT = path.resolve(__dirname, "../../../..");
const COVERED = rlsCoveredTables(ROOT);
/** requireCapability binds the signed-in caller's workspace; its subtree is
 *  request-scoped, not the cron's responsibility. */
const STOP_AT = new Set(["src/lib/auth/require-capability.ts"]);

interface CronContext {
  system?: string[];
  workspace?: string[];
  reason: string;
}

const CRON = (name: string) => `src/app/api/cron/${name}/route.ts`;

/** Every scheduled route that reaches a covered table, and where its context is set. */
const CRON_CONTEXT: Record<string, CronContext> = {
  [CRON("agent-drift")]: {
    system: ["src/lib/agents/drift/store.ts"],
    workspace: ["src/lib/agents/drift/store.ts"],
    reason: "Enumerates active agents fleet-wide (system); each drift check runs under the agent's workspace.",
  },
  [CRON("agent-model-eval")]: {
    system: ["src/lib/agents/evals/store.ts"],
    workspace: ["src/lib/agents/evals/store.ts"],
    reason: "Enumerates active agents fleet-wide (system); each eval runs under the agent's workspace.",
  },
  [CRON("agent-failover")]: {
    system: [CRON("agent-failover")],
    reason: "Called with no workspace, reclaims stalled tasks and reassigns agents across the whole fleet (dynamic WHERE).",
  },
  [CRON("ai-code-merge-poll")]: {
    workspace: [CRON("ai-code-merge-poll")],
    reason: "Single workspace: the factory's (resolveWorkspace(null)).",
  },
  [CRON("ai-code-reuse-index")]: {
    system: ["src/lib/ai-code/watched-repos.ts"],
    workspace: [CRON("ai-code-reuse-index")],
    reason: "Work list of watched repos is cross-workspace (system); each repo indexes under its workspace.",
  },
  [CRON("ai-code-watch")]: {
    system: ["src/lib/ai-code/watched-repos.ts"],
    workspace: [CRON("ai-code-watch")],
    reason: "Work list of watched repos is cross-workspace (system); each target's PR work runs under its workspace.",
  },
  [CRON("ai-redteam")]: {
    workspace: [CRON("ai-redteam")],
    reason: "Single workspace per run (default for the cron, the caller's for an admin run).",
  },
  [CRON("engagement-sweep")]: {
    workspace: [CRON("engagement-sweep")],
    reason: "Sweeps the default workspace only.",
  },
  [CRON("pentest-sweep")]: {
    workspace: [CRON("pentest-sweep")],
    reason: "Sweeps the default workspace only.",
  },
  [CRON("forcefield-learn")]: {
    workspace: [CRON("forcefield-learn")],
    reason: "Works the Forcefield edge workspace only (FORCEFIELD_EDGE_WORKSPACE_ID).",
  },
  [CRON("integration-health")]: {
    workspace: [CRON("integration-health"), "src/lib/health/integration-probes.ts"],
    reason: "Per-workspace probes; the work list reads instinct_connector_credentials, which has no policy yet. Self-checks run in default.",
  },
  [CRON("ogiam-checkpoint")]: {
    system: ["src/lib/ogiam/checkpoint.ts"],
    workspace: ["src/lib/ogiam/checkpoint.ts"],
    reason: "Finds workspaces with unsigned decisions (system); each checkpoint is signed under its workspace.",
  },
  [CRON("routine-schedules")]: {
    system: ["src/lib/assistant/routines/schedule-store.ts"],
    workspace: ["src/lib/assistant/routines/sweep.ts"],
    reason: "Due schedules across workspaces (system); each routine runs under its owner's workspace.",
  },
  [CRON("site-acceptance")]: {
    system: ["src/lib/site-acceptance/store.ts"],
    workspace: ["src/lib/site-acceptance/service.ts"],
    reason: "Claims from the shared run queue (system); each run executes under its workspace.",
  },
  ["src/app/api/admin/ogiam/governance-alerts/scan/route.ts"]: {
    workspace: ["src/app/api/admin/ogiam/governance-alerts/scan/route.ts"],
    reason: "Single workspace per scan (default for the cron, the caller's for an admin run).",
  },
};

/** Sweeps with a cross-workspace read on a covered table that may skip
 *  withSystemScope. Each needs a reason. Empty today. */
const SWEEP_EXEMPT: Record<string, string> = {};

const routes = scheduledRoutes(ROOT);
const reach = new Map(routes.map((r) => [r, cronReach(ROOT, r, COVERED, STOP_AT)]));
const src = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

describe("RLS context: scheduled routes", () => {
  it("finds the routes and the covered tables (the scan is not vacuous)", () => {
    expect(routes.length).toBeGreaterThanOrEqual(25);
    expect(COVERED.size).toBe(78);
    expect([...reach.values()].filter((r) => Object.keys(r.touching).length > 0).length).toBeGreaterThanOrEqual(10);
  });

  it.each(routes)("%s: reaches no covered table, or declares its context", (route) => {
    const touching = reach.get(route)!.touching;
    if (Object.keys(touching).length === 0) return;
    const entry = CRON_CONTEXT[route];
    if (!entry) {
      throw new Error(
        `${route} reaches RLS-covered tables (${JSON.stringify(touching)}) with no declared context. ` +
          `Wrap its work in runWithRequestWorkspace(ws, ...) (or withSystemScope for a cross-workspace enumeration) ` +
          `and add it to CRON_CONTEXT in this file with a reason.`,
      );
    }
  });

  it.each(Object.entries(CRON_CONTEXT))("%s: the declared context is really set where it says", (route, entry) => {
    expect(routes).toContain(route);
    expect(entry.reason.length).toBeGreaterThan(10);
    expect(entry.system?.length || entry.workspace?.length).toBeTruthy();
    const r = reach.get(route)!;
    expect(Object.keys(r.touching).length).toBeGreaterThan(0); // stale entries fail
    for (const kind of ["system", "workspace"] as ContextKind[]) {
      for (const file of entry[kind] ?? []) {
        expect({ route, file, reachable: r.reachable.has(file) }).toEqual({ route, file, reachable: true });
        expect({ file, kind, sets: setsContext(src(file), kind) }).toEqual({ file, kind, sets: true });
      }
    }
  });
});

describe("RLS context: cross-workspace sweeps", () => {
  const sweeps = [
    ...new Set(
      scanRepo(ROOT)
        .offenders.filter((o) => o.klass === "system-cross-workspace" && COVERED.has(o.table))
        .map((o) => o.file),
    ),
  ].sort();

  it("the doc's seven sites are all found", () => {
    expect(sweeps).toEqual(
      expect.arrayContaining([
        "src/lib/agents/drift/store.ts",
        "src/lib/agents/evals/store.ts",
        "src/lib/ai-code/watched-repos.ts",
        "src/lib/assistant/routines/schedule-store.ts",
        "src/lib/forcefield/operator-reputation.ts",
        "src/lib/ogiam/checkpoint.ts",
        "src/lib/site-acceptance/store.ts",
      ]),
    );
  });

  it.each(sweeps)("%s wraps its cross-workspace read in withSystemScope", (file) => {
    if (SWEEP_EXEMPT[file]) return;
    expect({ file, sets: setsContext(src(file), "system") }).toEqual({ file, sets: true });
  });

  it("every exemption is still needed and has a reason", () => {
    for (const [file, reason] of Object.entries(SWEEP_EXEMPT)) {
      expect(sweeps).toContain(file);
      expect(reason.length).toBeGreaterThan(10);
    }
  });
});

describe("rls-context-scan (the guard's own logic)", () => {
  it("names covered tables only inside SQL literals", () => {
    const cov = new Set(["lms_courses", "ogiam_decisions"]);
    expect(coveredTablesIn("const t = `SELECT id FROM lms_courses WHERE x = $1`;", cov)).toEqual(["lms_courses"]);
    expect(coveredTablesIn("// lms_courses mentioned in a comment\nconst s = 'lms_courses';", cov)).toEqual([]);
    expect(coveredTablesIn("`UPDATE ogiam_decisions SET a = 1`", cov)).toEqual(["ogiam_decisions"]);
  });

  it("tells the two context kinds apart", () => {
    expect(setsContext("await withSystemScope(() => q())", "system")).toBe(true);
    expect(setsContext("await withSystemScope(() => q())", "workspace")).toBe(false);
    expect(setsContext("runWithRequestWorkspace(ws, fn)", "workspace")).toBe(true);
    expect(setsContext("import { withSystemScope } from 'x'", "system")).toBe(false);
  });

  it("reads runtime imports and skips type-only ones", () => {
    const s = [
      `import { a } from "@/lib/a";`,
      `import type { T } from "@/lib/types";`,
      `import "./side-effect";`,
      `export { b } from "./b";`,
      `const { q } = await import("@/lib/db");`,
      `import {\n  c,\n  d,\n} from "./multi";`,
    ].join("\n");
    expect(runtimeImports(s).sort()).toEqual(["./b", "./multi", "./side-effect", "@/lib/a", "@/lib/db"].sort());
  });

  it("an unscoped cron that reaches a covered table through a helper is caught", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rls-guard-${process.pid}-`));
    try {
      const w = (rel: string, body: string) => {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), body);
      };
      w("src/app/api/cron/new-job/route.ts", `import { sweep } from "@/lib/new-job";\nexport async function GET() { await sweep(); }`);
      w("src/lib/new-job.ts", `import { list } from "./new-store";\nexport async function sweep() { return list(); }`);
      w("src/lib/new-store.ts", "export async function list() { return q(`SELECT id FROM lms_courses`); }");
      w("src/lib/auth/require-capability.ts", "export const x = `SELECT 1 FROM lms_courses`;");
      const files = reachableFiles(dir, "src/app/api/cron/new-job/route.ts", STOP_AT);
      expect(files.has("src/lib/new-store.ts")).toBe(true);
      const r = cronReach(dir, "src/app/api/cron/new-job/route.ts", new Set(["lms_courses"]), STOP_AT);
      expect(r.touching).toEqual({ "src/lib/new-store.ts": ["lms_courses"] });
      expect(CRON_CONTEXT["src/app/api/cron/new-job/route.ts"]).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
