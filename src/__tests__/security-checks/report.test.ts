import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countBySeverity,
  emitReport,
  hasFailingFindings,
  mapPool,
  newReport,
  parseCliOptions,
  renderMarkdown,
  sortFindings,
  type Finding,
} from "../../../scripts/security/lib/report";

const f = (severity: Finding["severity"], subject = "x"): Finding => ({ severity, rule: "r", subject, detail: "d | with pipe" });

describe("report", () => {
  it("fails at or above the threshold only", () => {
    const r = newReport("t");
    r.findings = [f("low")];
    expect(hasFailingFindings(r)).toBe(false);
    expect(hasFailingFindings(r, "low")).toBe(true);
    r.findings.push(f("high"));
    expect(hasFailingFindings(r, "high")).toBe(true);
    expect(hasFailingFindings(r, "critical")).toBe(false);
  });

  it("sorts by severity then subject and counts", () => {
    const sorted = sortFindings([f("low", "b"), f("critical", "z"), f("low", "a")]);
    expect(sorted.map((x) => `${x.severity}:${x.subject}`)).toEqual(["critical:z", "low:a", "low:b"]);
    expect(countBySeverity(sorted)).toEqual({ critical: 1, high: 0, medium: 0, low: 2, info: 0 });
  });

  it("renders a skipped report so the first line says it did not run", () => {
    const r = newReport("t");
    r.skipped = "No token. Add AZURE_CLIENT_ID.";
    const md = renderMarkdown(r);
    expect(md).toContain("**SKIPPED.** No token. Add AZURE_CLIENT_ID.");
    expect(md).not.toContain("**Findings:**");
  });

  it("escapes pipes inside table cells", () => {
    const r = newReport("t");
    r.findings = [f("high")];
    expect(renderMarkdown(r)).toContain("d \\| with pipe");
  });

  it("parses --out and --fail-on and rejects an unknown severity", () => {
    expect(parseCliOptions(["--out", "/tmp/x", "--fail-on", "high"], "def")).toEqual({ outDir: "/tmp/x", failOn: "high" });
    expect(parseCliOptions([], "def")).toEqual({ outDir: "def", failOn: "medium" });
    expect(() => parseCliOptions(["--fail-on", "nope"], "def")).toThrow();
  });

  it("writes JSON and markdown and returns 1 on findings, 0 when skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "sec-report-"));
    const write = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
    const prevSummary = process.env.GITHUB_STEP_SUMMARY;
    delete process.env.GITHUB_STEP_SUMMARY;
    try {
      const r = newReport("demo");
      r.findings = [f("medium")];
      expect(emitReport(r, { outDir: dir, failOn: "medium" })).toBe(1);
      const json = JSON.parse(readFileSync(join(dir, "demo.json"), "utf8"));
      expect(json.findings).toHaveLength(1);
      expect(readFileSync(join(dir, "demo.md"), "utf8")).toContain("## Security check: demo");
      const s = newReport("skip");
      s.skipped = "no creds";
      s.findings = [f("critical")];
      expect(emitReport(s, { outDir: dir, failOn: "medium" })).toBe(0);
    } finally {
      write.mockRestore();
      if (prevSummary !== undefined) process.env.GITHUB_STEP_SUMMARY = prevSummary;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mapPool preserves order and bounds concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapPool([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});
