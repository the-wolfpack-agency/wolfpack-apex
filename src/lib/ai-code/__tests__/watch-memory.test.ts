/**
 * The watcher remembers. These tests reproduce the 2026-10-08 loop and prove
 * it stops.
 *
 * What happened: eight factory PRs on one repo sat at a terminal step (an
 * escalation, which adds no commit, so the head SHA never changed). The cron
 * ran every ten minutes with no memory and re-drove all eight on every tick
 * for ten days: about 1,150 drives a day, each paying for a model call.
 *
 * What must be true now:
 *   - a terminal decision on a SHA is remembered and never re-driven;
 *   - an unchanged SHA is parked after MAX_DRIVES_PER_SHA counted drives;
 *   - a PR is capped at DAILY_DRIVE_CAP drives per UTC day across SHAs;
 *   - a new push (new SHA) earns a fresh look;
 *   - "wait" (CI still running, no model call) never counts;
 *   - unknown head or unreadable memory fails CLOSED (skip, do not drive);
 *   - events fire once at the transition, not per skipped tick.
 */
import {
  runAiCodeWatch,
  shouldDrive,
  driveCounts,
  inMemoryWatchMemory,
  dbWatchMemory,
  WATCH_SQL,
  MAX_DRIVES_PER_SHA,
  DAILY_DRIVE_CAP,
  isProtectedFixPath,
  protectedPathsIn,
  protectedPathVerdict,
  type WatchDeps,
  type WatchMemory,
  type WatchPr,
} from "@/lib/ai-code/watch";

jest.mock("@/lib/db", () => ({ query: jest.fn() }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

const REPO = "the-org/stuck-repo";
const EIGHT: WatchPr[] = [6, 7, 9, 24, 25, 26, 27, 28].map((n) => ({ number: n, headRef: `factory/fix-${n}`, baseRef: "main" }));

function harness(opts: { drive?: WatchDeps["drive"]; heads?: Record<number, string>; memory?: WatchMemory; start?: Date } = {}) {
  const memory = opts.memory ?? inMemoryWatchMemory();
  const heads = opts.heads ?? {};
  const events: Array<[string, Record<string, unknown>]> = [];
  let now = opts.start ?? new Date("2026-10-08T00:00:00Z");
  const drive = jest.fn(opts.drive ?? (async () => ({ action: "escalate", terminal: true })));
  const deps: WatchDeps = {
    targets: [{ workspaceId: "w1", repo: REPO }],
    listPRs: async () => EIGHT,
    resolveHead: async (_t, pr) => heads[pr.number] ?? `sha-${pr.number}`,
    drive,
    memory,
    now: () => now,
    track: (e, m) => events.push([e, m]),
  };
  return {
    deps,
    drive,
    events,
    heads,
    tick: () => runAiCodeWatch(deps),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

const TEN_MIN = 10 * 60 * 1000;

describe("the 10-08 loop, reproduced", () => {
  it("terminal escalations: each PR is driven ONCE, then never again across ten days of ticks", async () => {
    const h = harness();
    for (let i = 0; i < 6 * 24 * 10; i++) {
      await h.tick();
      h.advance(TEN_MIN);
    }
    /* The old watcher made 8 drives per tick: 11,520 over these ten days. */
    expect(h.drive).toHaveBeenCalledTimes(8);
    expect(h.events.filter(([e]) => e === "ai.code_watch_parked")).toHaveLength(8);
  });

  it("non-terminal escalations (no commit, same SHA) park after the per-SHA budget", async () => {
    const h = harness({ drive: async () => ({ action: "escalate", terminal: false }) });
    for (let i = 0; i < 100; i++) await h.tick();
    expect(h.drive).toHaveBeenCalledTimes(8 * MAX_DRIVES_PER_SHA);
    const parked = h.events.filter(([e]) => e === "ai.code_watch_parked");
    expect(parked).toHaveLength(8);
    expect(parked[0][1]).toMatchObject({ reason: "sha_attempts_exhausted", repo: REPO, workspace_id: "w1" });
  });

  it("skipped PRs report why", async () => {
    const h = harness();
    await h.tick();
    const s = await h.tick();
    expect(s.driven).toHaveLength(0);
    expect(s.skipped.map((x) => x.reason)).toEqual(Array(8).fill("terminal_unchanged"));
  });
});

describe("what earns a fresh look", () => {
  it("a new push (new head SHA) is driven again", async () => {
    const h = harness();
    await h.tick();
    expect(h.drive).toHaveBeenCalledTimes(8);
    h.heads[6] = "sha-6-new-push";
    await h.tick();
    expect(h.drive).toHaveBeenCalledTimes(9);
    expect(h.drive.mock.calls[8][1].number).toBe(6);
  });

  it("'wait' (CI running, no model call) never counts against a budget", async () => {
    const h = harness({ drive: async () => ({ action: "wait", terminal: false }) });
    for (let i = 0; i < 20; i++) await h.tick();
    expect(h.drive).toHaveBeenCalledTimes(8 * 20);
    expect(h.events).toHaveLength(0);
  });
});

describe("the per-PR daily cap", () => {
  it("caps drives per PR per UTC day across SHAs, then resets the next day", async () => {
    /* Every tick is a new SHA (a fix commit), so only the daily cap can stop it. */
    let n = 0;
    const h = harness({ drive: async () => ({ action: "fix_committed", terminal: false }) });
    h.deps.resolveHead = async (_t, pr) => `sha-${pr.number}-${n}`;
    for (let i = 0; i < 20; i++) {
      n++;
      await h.tick();
    }
    expect(h.drive).toHaveBeenCalledTimes(8 * DAILY_DRIVE_CAP);
    expect(h.events.filter(([e]) => e === "ai.code_watch_daily_cap_reached")).toHaveLength(8);
    h.advance(24 * 60 * 60 * 1000);
    n++;
    await h.tick();
    expect(h.drive).toHaveBeenCalledTimes(8 * DAILY_DRIVE_CAP + 8);
  });
});

describe("fails closed", () => {
  it("an unknown head SHA is never driven", async () => {
    const h = harness();
    h.deps.resolveHead = async () => null;
    const s = await h.tick();
    expect(h.drive).not.toHaveBeenCalled();
    expect(s.skipped.every((x) => x.reason === "head_unknown")).toBe(true);
  });

  it("a head lookup that throws is never driven", async () => {
    const h = harness();
    h.deps.resolveHead = async () => {
      throw new Error("404");
    };
    await h.tick();
    expect(h.drive).not.toHaveBeenCalled();
  });

  it("unreadable memory is never read as 'never driven'", async () => {
    const broken: WatchMemory = {
      get: async () => {
        throw new Error("db down");
      },
      dailyAttempts: async () => 0,
      record: async () => {
        throw new Error("unreachable");
      },
    };
    const h = harness({ memory: broken });
    const s = await h.tick();
    expect(h.drive).not.toHaveBeenCalled();
    expect(s.skipped.every((x) => x.reason === "memory_unavailable")).toBe(true);
  });

  it("a PR the caller reports as closed is never driven", async () => {
    const h = harness();
    h.deps.listPRs = async () => [{ ...EIGHT[0], state: "closed" }];
    const s = await h.tick();
    expect(h.drive).not.toHaveBeenCalled();
    expect(s.skipped[0].reason).toBe("not_open");
  });
});

describe("shouldDrive and driveCounts (the rule in one place)", () => {
  it("terminal beats everything", () => {
    expect(shouldDrive({ state: { terminal: true, attempts: 0, lastAction: null }, dailyAttempts: 0 })).toEqual({ drive: false, reason: "terminal_unchanged" });
  });
  it("a fresh SHA with room is driven", () => {
    expect(shouldDrive({ state: null, dailyAttempts: 0 })).toEqual({ drive: true });
  });
  it("only wait is free", () => {
    expect(driveCounts("wait")).toBe(false);
    for (const a of ["escalate", "merge_ready", "fix_committed", undefined]) expect(driveCounts(a)).toBe(true);
  });
});

describe("dbWatchMemory issues the real statements", () => {
  it("reads state and daily, and records both with the counts flag", async () => {
    const run = jest.fn(async (sql: string) => {
      if (sql === WATCH_SQL.get) return { rows: [{ terminal: true, attempts: 2, last_action: "escalate" }] };
      if (sql === WATCH_SQL.daily) return { rows: [{ attempts: 4 }] };
      if (sql === WATCH_SQL.recordState) return { rows: [{ terminal: true, attempts: 3, last_action: "escalate" }] };
      return { rows: [{ attempts: 5 }] };
    });
    const m = dbWatchMemory(run);
    const key = { workspaceId: "w1", repo: REPO, pr: 6, headSha: "abc" };
    expect(await m.get(key)).toEqual({ terminal: true, attempts: 2, lastAction: "escalate" });
    expect(await m.dailyAttempts(key, "2026-10-08")).toBe(4);
    expect(await m.record(key, "2026-10-08", { action: "escalate", terminal: true, counts: true })).toEqual({
      state: { terminal: true, attempts: 3, lastAction: "escalate" },
      dailyAttempts: 5,
    });
    expect(run).toHaveBeenCalledWith(WATCH_SQL.recordState, ["w1", REPO, 6, "abc", true, true, "escalate"]);
    expect(run).toHaveBeenCalledWith(WATCH_SQL.recordDaily, ["w1", REPO, 6, "2026-10-08", true]);
  });

  it("propagates a read error (never swallows it into 'no state')", async () => {
    const m = dbWatchMemory(async () => {
      throw new Error("db down");
    });
    await expect(m.get({ workspaceId: "w1", repo: REPO, pr: 1, headSha: "x" })).rejects.toThrow("db down");
  });

  it("terminal is sticky in SQL", () => {
    expect(WATCH_SQL.recordState).toMatch(/terminal = instinct_ai_code_watch_state\.terminal OR EXCLUDED\.terminal/);
  });
});

describe("protected paths an authored fix may never edit", () => {
  it.each([
    "src/lib/ai/__tests__/router.test.ts",
    "src/components/Foo.test.tsx",
    "e2e/smoke.spec.ts",
    "tests/unit/a.js",
    ".github/workflows/ci.yml",
    "./.github/CODEOWNERS",
    ".husky/pre-push",
    "src/lib/ai-code/assess.ts",
    "src/lib/ai-code/gate-config.ts",
    "src/lib/ai-code/watch.ts",
    "src/lib/ai-code/ci-fix-runner.ts",
    "src/lib/gates/run-gate.ts",
    "src/lib/ai/policy.ts",
    "src/lib/ai/retention.ts",
    "src/app/api/cron/ai-code-watch/route.ts",
    "src/db/migrations/293_ai_code_watch_state.sql",
    "scripts/verify.sh",
    "jest.config.ts",
    "package.json",
    "package-lock.json",
    "vercel.json",
    "tsconfig.json",
  ])("%s is protected", (p) => {
    expect(isProtectedFixPath(p)).toBe(true);
  });

  it.each(["src/lib/utils/deepMerge.ts", "src/app/page.tsx", "README.md", "src/lib/ai-code/author.ts", "src/lib/testing-helpers.ts"])(
    "%s is editable",
    (p) => {
      expect(isProtectedFixPath(p)).toBe(false);
    },
  );

  it("protectedPathsIn lists the offending paths once, normalized", () => {
    expect(
      protectedPathsIn([{ path: "src/a.ts" }, { path: "./.github/workflows/x.yml" }, { path: ".github/workflows/x.yml" }, { path: "src/x.test.ts" }]),
    ).toEqual([".github/workflows/x.yml", "src/x.test.ts"]);
  });
});

describe("protectedPathVerdict (what ci-fix-runner's gate returns)", () => {
  it("refuses a fix that edits a test or a workflow, naming the paths", () => {
    const v = protectedPathVerdict([{ path: "src/lib/x.ts" }, { path: "src/lib/__tests__/x.test.ts" }, { path: ".github/workflows/ci.yml" }]);
    expect(v).toEqual({
      cleared: false,
      blockedBy: "protected_path:src/lib/__tests__/x.test.ts,.github/workflows/ci.yml",
      paths: ["src/lib/__tests__/x.test.ts", ".github/workflows/ci.yml"],
    });
  });
  it("passes a fix that edits only product code to the normal gate", () => {
    expect(protectedPathVerdict([{ path: "src/lib/x.ts" }])).toBeNull();
  });
});

describe("both fixers refuse protected paths BEFORE the security scan (source guard)", () => {
  /* driveCiFixStep and the ci-autofix gate are wired to GitHub and a model, so
     this pins the wiring in source: the verdict is computed, and before
     assessChange, in each fixer. */
  const fs = jest.requireActual<typeof import("fs")>("fs");
  const path = jest.requireActual<typeof import("path")>("path");
  const root = path.resolve(__dirname, "../../../..");
  it.each(["src/lib/ai-code/ci-fix-runner.ts", "src/lib/gates/ci-autofix-gate.ts"])("%s", (file) => {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    const verdictAt = src.indexOf("protectedPathVerdict(changes)");
    const assessAt = src.indexOf("assessChange(filesToDiff(changes))");
    expect(verdictAt).toBeGreaterThan(0);
    expect(assessAt).toBeGreaterThan(verdictAt);
  });
  it("the list protects itself", () => {
    expect(isProtectedFixPath("src/lib/ai-code/protected-paths.ts")).toBe(true);
  });
});
