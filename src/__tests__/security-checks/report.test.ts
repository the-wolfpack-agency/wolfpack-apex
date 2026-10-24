import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  countBySeverity,
  emitReport,
  isRedacted,
  renderRedactedMarkdown,
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
      expect(emitReport(r, { outDir: dir, failOn: "medium" }, {})).toBe(1);
      const json = JSON.parse(readFileSync(join(dir, "demo.json"), "utf8"));
      expect(json.findings).toHaveLength(1);
      expect(readFileSync(join(dir, "demo.md"), "utf8")).toContain("## Security check: demo");
      const s = newReport("skip");
      s.skipped = "no creds";
      s.findings = [f("critical")];
      expect(emitReport(s, { outDir: dir, failOn: "medium" }, {})).toBe(0);
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

  describe("public-repository redaction (Actions output of a public repo is world-readable)", () => {
    const secret = (): Finding => ({ severity: "critical", rule: "mail-send-tenant-wide", subject: "private-repo-name", detail: "handlebars 4.7.9", source: "osv" });

    it("redacts inside Actions unless the workflow states the repo is private (fail closed)", () => {
      expect(isRedacted({})).toBe(false);
      expect(isRedacted({ GITHUB_ACTIONS: "true" })).toBe(true);
      expect(isRedacted({ GITHUB_ACTIONS: "true", SECURITY_REPORT_PUBLIC: "true" })).toBe(true);
      expect(isRedacted({ GITHUB_ACTIONS: "true", SECURITY_REPORT_PUBLIC: "" })).toBe(true);
      expect(isRedacted({ GITHUB_ACTIONS: "true", SECURITY_REPORT_PUBLIC: "false" })).toBe(false);
    });

    it("the redacted render carries counts only, never subjects, details, rules, sources, stats or notes", () => {
      const r = newReport("supply-chain");
      r.findings = [secret(), f("low")];
      r.stats = { "private-repo-count-key": 12 };
      r.notes = ["Dependabot disabled on private-repo-name"];
      const md = renderRedactedMarkdown(r);
      expect(md).toContain("critical 1");
      expect(md).toContain("low 1");
      for (const leak of ["private-repo-name", "handlebars", "mail-send-tenant-wide", "osv", "private-repo-count-key"]) {
        expect(md).not.toContain(leak);
      }
    });

    it("when redacted: writes no report files, prints and summarizes counts only, keeps the exit code", () => {
      const dir = mkdtempSync(join(tmpdir(), "sec-redact-"));
      const outDir = join(dir, "out");
      const summary = join(dir, "summary.md");
      writeFileSync(summary, "");
      const printed: string[] = [];
      const write = jest.spyOn(process.stdout, "write").mockImplementation((c: string | Uint8Array) => { printed.push(String(c)); return true; });
      try {
        const r = newReport("supply-chain");
        r.findings = [secret()];
        const code = emitReport(r, { outDir, failOn: "medium" }, { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: summary });
        expect(code).toBe(1);
        expect(existsSync(outDir) ? readdirSync(outDir) : []).toEqual([]);
        const all = printed.join("") + readFileSync(summary, "utf8");
        expect(all).toContain("critical 1");
        expect(all).not.toContain("private-repo-name");
        expect(all).not.toContain("handlebars");
      } finally {
        write.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("every security workflow that keeps reports marks visibility and uploads only from a private repo", () => {
      const wfDir = join(__dirname, "../../../.github/workflows");
      const files = readdirSync(wfDir).filter((n) => /^security-.*\.ya?ml$/.test(n));
      const reporting = files.filter((n) => readFileSync(join(wfDir, n), "utf8").includes("path: security-reports/"));
      expect(reporting.length).toBeGreaterThanOrEqual(4);
      for (const n of reporting) {
        const wf = readFileSync(join(wfDir, n), "utf8");
        expect({ n, marks: wf.includes("SECURITY_REPORT_PUBLIC: ${{ github.event.repository.private && 'false' || 'true' }}") }).toEqual({ n, marks: true });
        const uploads = wf.split("uses: actions/upload-artifact").length - 1;
        const gated = (wf.match(/if: [^\n]*github\.event\.repository\.private\n\s+uses: actions\/upload-artifact/g) ?? []).length;
        expect({ n, uploads, gated }).toEqual({ n, uploads, gated: uploads });
      }
    });
  });
});
