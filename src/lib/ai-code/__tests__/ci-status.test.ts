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
  it("treats timed_out / cancelled / action_required as failures", () => {
    const s = summarizeChecks([run("a", "completed", "timed_out"), run("b", "completed", "cancelled"), run("c", "completed", "action_required")]);
    expect(s.failed).toBe(3);
    expect(s.ciComplete).toBe(false);
  });
});
