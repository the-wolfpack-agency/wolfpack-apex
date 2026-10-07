/**
 * Campaigns reconstructed from recorded events: the detector run per operator over
 * what was logged. Tested where the risk is - one operator's hostile sequence is
 * found, two operators are not cross-contaminated, and a benign operator is not
 * flagged. The DB reader is exercised with an injected query (no database).
 */
import { campaignsFromEvents, readOperatorCampaigns, type RecordedStep } from "../campaign-events";

const step = (fp: string, path: string, tsMs: number): RecordedStep => ({ fp, path, tsMs });

describe("campaignsFromEvents", () => {
  it("detects one operator's recon-then-export kill chain", () => {
    const rows = [
      step("fpA", "/admin/users", 1000),
      step("fpA", "/export/users?format=csv", 2000),
    ];
    const out = campaignsFromEvents(rows);
    expect(out).toHaveLength(1);
    expect(out[0].fingerprint).toBe("fpA");
    expect(out[0].verdict.signatures.some((s) => s.id === "kill_chain")).toBe(true);
  });

  it("does NOT cross-contaminate operators (each fingerprint judged alone)", () => {
    // fpA does recon, fpB does the export - neither alone is a kill chain.
    const rows = [
      step("fpA", "/admin/users", 1000),
      step("fpB", "/export/users?format=csv", 2000),
    ];
    expect(campaignsFromEvents(rows)).toEqual([]);
  });

  it("does NOT flag a benign operator's normal browsing", () => {
    const rows = [step("fpC", "/", 1), step("fpC", "/pricing", 2), step("fpC", "/contact", 3)];
    expect(campaignsFromEvents(rows)).toEqual([]);
  });

  it("orders high-severity campaigns first", () => {
    const rows = [
      // fpHigh: kill chain (high)
      step("fpHigh", "/admin", 1), step("fpHigh", "/download/backup.sql", 2),
      // fpMed: recon breadth only (medium)
      step("fpMed", "/admin", 1), step("fpMed", "/.env", 2), step("fpMed", "/actuator", 3), step("fpMed", "/config", 4), step("fpMed", "/wp-admin", 5),
    ];
    const out = campaignsFromEvents(rows);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0].verdict.severity).toBe("high");
  });

  it("ignores rows with no fingerprint", () => {
    expect(campaignsFromEvents([{ fp: "", path: "/admin", tsMs: 1 } as RecordedStep])).toEqual([]);
  });
});

describe("readOperatorCampaigns (injected query)", () => {
  it("maps rows -> steps -> campaigns, scoped to the site", async () => {
    let boundParams: unknown[] = [];
    const q = async (_sql: string, params?: unknown[]) => {
      boundParams = params ?? [];
      return {
        rows: [
          { fp: "fpA", path: "/admin/users", created_at: "2026-10-07T00:00:01Z" },
          { fp: "fpA", path: "/export/users?format=csv", created_at: "2026-10-07T00:00:02Z" },
        ],
      };
    };
    const out = await readOperatorCampaigns("ogiam.com", {}, q as never);
    expect(out).toHaveLength(1);
    expect(out[0].verdict.campaign).toBe(true);
    // scoped to the site label (first bound param)
    expect(boundParams[0]).toBe("ogiam.com");
  });

  it("fails safe to [] on a query error (a campaign view never throws into a route)", async () => {
    const q = jest.fn(async () => { throw new Error("db down"); });
    expect(await readOperatorCampaigns("ogiam.com", {}, q as never)).toEqual([]);
  });
});
