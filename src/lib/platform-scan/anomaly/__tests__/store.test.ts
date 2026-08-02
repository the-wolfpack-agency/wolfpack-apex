/**
 * Persisting the baseline.
 *
 * The two tests that earn their keep are the ones asserting what the SQL does
 * NOT do: it never overwrites first_seen_at, and it never learns from a scan
 * that failed. Both are the kind of rule that is obviously right when written
 * and silently lost the next time someone edits the upsert, so they are pinned
 * against the query text as well as the behaviour.
 */
jest.mock("@/lib/db", () => ({ query: jest.fn() }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));

import { query } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { readBaseline, recordAnomalyRun, listAnomalyRuns } from "../store";
import { detectAnomalies } from "../detect";
import { buildDeclarations } from "../declared";
import type { NetworkObservation } from "../../network/observations";

const q = query as jest.Mock;
const PAGE = "https://client.example.com/";

function obs(url: string, over: Partial<NetworkObservation> = {}): NetworkObservation {
  return { url, pageUrl: PAGE, resourceType: "script", atMs: 100, status: 200, ...over };
}

beforeEach(() => {
  jest.clearAllMocks();
  // mockReset, not clearAllMocks alone: a test that short-circuits leaves its
  // unconsumed mockResolvedValueOnce values queued, and clearAllMocks does not
  // drain that queue. The first version of this file had exactly that bug, and
  // it showed up as the NEXT test failing, which is the worst way to find it.
  q.mockReset();
});

/** Rows for: run-count probe, then the baseline select. */
function mockReads(runCount: number, rows: Record<string, unknown>[]) {
  q.mockResolvedValueOnce({ rows: [{ n: String(runCount) }] }).mockResolvedValueOnce({ rows });
}

describe("readBaseline", () => {
  it("returns undefined when this target has never been scanned", async () => {
    // Distinct from an empty array. detect.ts refuses to call anything new in
    // the first case and is free to in the second.
    mockReads(0, []);
    expect(await readBaseline("ws", "t1")).toBeUndefined();
  });

  it("returns an empty array when it HAS been scanned and saw nothing", async () => {
    mockReads(3, []);
    expect(await readBaseline("ws", "t1")).toEqual([]);
  });

  it("maps rows into the shape detect.ts takes", async () => {
    mockReads(1, [
      { host: "hotjar.com", first_seen_at: "2026-01-01T00:00:00.000Z", last_seen_at: "2026-07-01T00:00:00.000Z", scan_count: 4 },
    ]);
    expect(await readBaseline("ws", "t1")).toEqual([
      { host: "hotjar.com", firstSeenAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-07-01T00:00:00.000Z", scanCount: 4 },
    ]);
  });

  it("scopes both reads to the workspace AND the target", async () => {
    mockReads(1, []);
    await readBaseline("ws-42", "t-9");
    for (const call of q.mock.calls) {
      expect(call[0]).toContain("workspace_id = $1");
      expect(call[1].slice(0, 2)).toEqual(["ws-42", "t-9"]);
    }
  });
});

describe("recordAnomalyRun", () => {
  const declarations = buildDeclarations({ pageUrl: PAGE, headers: { "content-security-policy": "connect-src 'self'" } });

  function run(observations: NetworkObservation[], pageLoaded?: boolean) {
    const report = detectAnomalies({ observations, declarations, baseline: [], pageLoaded });
    return recordAnomalyRun({ workspaceId: "ws", targetId: "t1", pageUrl: PAGE, report, observations, pageLoaded });
  }

  it("never overwrites first_seen_at", async () => {
    // "When did this appear" is the question an incident review asks, and it is
    // unanswerable once the value has been stamped over.
    q.mockResolvedValue({ rows: [{ id: "run-1" }] });
    await run([obs("https://hotjar.com/hj.js")], true);
    const upsert = q.mock.calls.find((c) => String(c[0]).includes("instinct_scan_host_baseline"));
    expect(upsert).toBeDefined();
    expect(upsert![0]).toMatch(/DO UPDATE[\s\S]*SET/);
    expect(upsert![0]).not.toMatch(/SET[\s\S]*first_seen_at\s*=/);
  });

  it("increments rather than replacing the scan count", async () => {
    q.mockResolvedValue({ rows: [{ id: "run-1" }] });
    await run([obs("https://hotjar.com/hj.js")], true);
    const upsert = q.mock.calls.find((c) => String(c[0]).includes("instinct_scan_host_baseline"))!;
    expect(upsert[0]).toMatch(/scan_count\s*=\s*instinct_scan_host_baseline\.scan_count\s*\+\s*1/);
  });

  it("does NOT touch the baseline when the page failed to load", async () => {
    // One failed run must not erase the history that makes novelty detectable.
    q.mockResolvedValue({ rows: [{ id: "run-1" }] });
    const res = await run([obs("https://hotjar.com/hj.js")], false);
    expect(res.baselineUpdated).toBe(false);
    expect(q.mock.calls.some((c) => String(c[0]).includes("instinct_scan_host_baseline"))).toBe(false);
  });

  it("does NOT touch the baseline when nothing at all was observed", async () => {
    q.mockResolvedValue({ rows: [{ id: "run-1" }] });
    const res = await run([], true);
    expect(res.baselineUpdated).toBe(false);
  });

  it("still records the run when it refuses to learn from it", async () => {
    // A gap in coverage should be visible, not look like a clean stretch.
    q.mockResolvedValue({ rows: [{ id: "run-1" }] });
    await run([], true);
    const insert = q.mock.calls.find((c) => String(c[0]).includes("instinct_scan_anomaly_runs"))!;
    expect(insert[1]).toContain(false); // baseline_updated
  });

  it("stores the whole report, so a finding can be re-read as it was shown", async () => {
    q.mockResolvedValue({ rows: [{ id: "run-1" }] });
    await run([obs("https://hotjar.com/hj.js")], true);
    const insert = q.mock.calls.find((c) => String(c[0]).includes("instinct_scan_anomaly_runs"))!;
    const stored = JSON.parse(insert[1][3]);
    expect(stored.findings[0].host).toBe("hotjar.com");
    expect(stored.findings[0].summary).toContain("hotjar.com");
  });

  it("emits one event per unexplained host, not a single roll-up", async () => {
    // So the learning loop can answer "which vendors keep turning up
    // unannounced across our whole client base" without re-reading every report.
    q.mockResolvedValue({ rows: [{ id: "run-1" }] });
    await run([obs("https://hotjar.com/hj.js"), obs("https://mixpanel.com/m.js", { atMs: 200 })], true);
    const hostEvents = (trackEvent as jest.Mock).mock.calls.filter((c) => c[0] === "platform.unexplained_host_detected");
    expect(hostEvents.map((c) => c[3].host).sort()).toEqual(["hotjar.com", "mixpanel.com"]);
  });

  it("records whether the run was learned from, in the completion event", async () => {
    q.mockResolvedValue({ rows: [{ id: "run-1" }] });
    await run([obs("https://hotjar.com/hj.js")], true);
    const done = (trackEvent as jest.Mock).mock.calls.find((c) => c[0] === "platform.anomaly_run_completed")!;
    expect(done[3]).toMatchObject({ workspace_id: "ws", target_id: "t1", unexplained: 1, baseline_updated: true });
  });

  it("attributes to the system when no actor ran it, rather than to nobody", async () => {
    q.mockResolvedValue({ rows: [{ id: "run-1" }] });
    await run([obs("https://hotjar.com/hj.js")], true);
    const done = (trackEvent as jest.Mock).mock.calls.find((c) => c[0] === "platform.anomaly_run_completed")!;
    expect([done[1], done[2]]).toEqual(["system", "system"]);
  });

  it("scopes every write to the workspace", async () => {
    q.mockResolvedValue({ rows: [{ id: "run-1" }] });
    await run([obs("https://hotjar.com/hj.js")], true);
    for (const call of q.mock.calls) expect(call[1][0]).toBe("ws");
  });
});

describe("listAnomalyRuns", () => {
  it("clamps an absurd limit instead of passing it to the database", async () => {
    q.mockResolvedValue({ rows: [] });
    await listAnomalyRuns("ws", "t1", 10_000);
    expect(q.mock.calls[0][1][2]).toBe(100);
  });

  it("clamps a nonsense low limit too", async () => {
    q.mockResolvedValue({ rows: [] });
    await listAnomalyRuns("ws", "t1", 0);
    expect(q.mock.calls[0][1][2]).toBe(1);
  });
});
