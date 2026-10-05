/** @jest-environment node */
import { summarizeChecks } from "../ci-status";

const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion });

describe("summarizeChecks", () => {
  it("ciComplete when every check completed and passed", () => {
    const s = summarizeChecks([run("unit", "completed", "success"), run("lint", "completed", "success"), run("skip", "completed", "skipped")]);
    expect(s).toMatchObject({ total: 3, passed: 3, failed: 0, pending: 0, complete: true, ciComplete: true });
  });
  it("NOT ciComplete while a check is still running", () => {
    const s = summarizeChecks([run("unit", "completed", "success"), run("e2e", "in_progress", null)]);
    expect(s.complete).toBe(false);
    expect(s.ciComplete).toBe(false);
    expect(s.pending).toBe(1);
  });
  it("NOT ciComplete when a check failed, and names it", () => {
    const s = summarizeChecks([run("unit", "completed", "success"), run("CodeQL", "completed", "failure")]);
    expect(s.failed).toBe(1);
    expect(s.ciComplete).toBe(false);
    expect(s.failedChecks).toEqual(["CodeQL"]);
  });
  it("NOT ciComplete when no checks have run (nothing verified is not verified)", () => {
    const s = summarizeChecks([]);
    expect(s.ciComplete).toBe(false);
  });
  it("treats timed_out / action_required / startup_failure as genuine failures", () => {
    const s = summarizeChecks([run("a", "completed", "timed_out"), run("c", "completed", "action_required"), run("d", "completed", "startup_failure")]);
    expect(s.failed).toBe(3);
    expect(s.ciComplete).toBe(false);
  });

  // Regression: a cancelled / stale check means the run was superseded or did not
  // finish - NOT a defect to fix. Counting it as a failure made the autonomous
  // fixer thrash (each no-op commit cancels its own in-flight CI, which then read
  // as failed, so it re-authored and cancelled again). It must read as pending.
  it("treats cancelled / stale as pending (incomplete), never as a failure", () => {
    const s = summarizeChecks([run("unit", "completed", "success"), run("e2e", "completed", "cancelled"), run("db", "completed", "stale")]);
    expect(s.failed).toBe(0);
    expect(s.pending).toBe(2);
    expect(s.complete).toBe(false); // not settled -> fixer waits, does not author
    expect(s.ciComplete).toBe(false);
    expect(s.failedChecks).toEqual([]);
  });

  it("a cancelled check alongside a real failure still surfaces only the real failure", () => {
    const s = summarizeChecks([run("CodeQL", "completed", "failure"), run("e2e", "completed", "cancelled")]);
    expect(s.failed).toBe(1);
    expect(s.pending).toBe(1);
    expect(s.failedChecks).toEqual(["CodeQL"]);
  });
});
