import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KEY_SCANNERS,
  asCount,
  baselineFromScan,
  evaluatePentest,
  evaluateStatic,
  fingerprint,
  parseBaseline,
  renderCombined,
  renderStatic,
  staticOutputs,
  type ScanFinding,
  type ScanResults,
} from "../../../scripts/security/lib/self-scan";

/**
 * Reference vectors computed with the Python original,
 * agenticqa.security.finding_fingerprint.fingerprint (nhomyk/AgenticQA main,
 * 2026-10-24). The committed baseline was written by that function, so a
 * drift here would turn every known finding into a "new" one.
 */
const VECTORS: [ScanFinding, string][] = [
  [{ file: "src/app/api/x/route.ts", cwe: "CWE-639", rule_id: "IDOR_DIRECT", evidence: "  const  id = params.id  ", line: 10 }, "fd31b30abb66c44e"],
  [{ file: "src/lib/a.ts", cwe: "", rule_id: "JWT_NONE", message: "Alg None Accepted" }, "027117967620ad8a"],
  [{ file: "src/lib/b.ts", cwe: 79, rule_id: null, evidence: "X".repeat(300) }, "46f65432abf56565"],
  [{ file: "src/lib/c.ts", evidence: "tab\tand\nnewline  ÉCOLE" }, "99ae4a3bd044b65b"],
  [{}, "be5be69f55e91af2"],
];

const SECRET_FILE = "src/lib/secret-place.ts";

function finding(over: Partial<ScanFinding> = {}): ScanFinding {
  return { file: SECRET_FILE, cwe: "CWE-639", rule_id: "IDOR", severity: "high", message: "Direct object reference", evidence: "params.id", line: 3, ...over };
}

function scan(findingsByScanner: Partial<Record<(typeof KEY_SCANNERS)[number], ScanFinding[]>>, over: Partial<ScanResults> = {}): ScanResults {
  const scanners: ScanResults["scanners"] = {};
  for (const name of KEY_SCANNERS) {
    const list = findingsByScanner[name] ?? [];
    scanners[name] = { status: "ok", result: { findings: list, total_findings: list.length, critical: list.filter((f) => f.severity === "critical").length } };
  }
  return { summary: { total_findings: 7, total_critical: 1, risk_level: "low" }, scanners, ...over };
}

describe("fingerprint matches the Python original", () => {
  it.each(VECTORS)("%j", (f, expected) => {
    expect(fingerprint(f)).toBe(expected);
  });

  it("ignores the line number", () => {
    expect(fingerprint(finding({ line: 1 }))).toBe(fingerprint(finding({ line: 999 })));
  });
});

describe("evaluateStatic", () => {
  it("a finding in the baseline is not new; a finding outside it is", () => {
    const known = finding();
    const fresh = finding({ file: "src/lib/other.ts", severity: "critical" });
    const g = evaluateStatic(scan({ idor: [known, fresh] }), [fingerprint(known)]);
    expect(g.newFindings.map((f) => f.file)).toEqual(["src/lib/other.ts"]);
    expect(g.newCriticalHigh).toBe(1);
    expect(g.keyFindings).toBe(2);
    expect(g.resolved).toBe(0);
    expect(g.scannerErrors).toEqual([]);
  });

  it("new medium/low findings are counted but do not gate", () => {
    const g = evaluateStatic(scan({ rate_limit: [finding({ severity: "medium" })] }), []);
    expect(g.newFindings).toHaveLength(1);
    expect(g.newCriticalHigh).toBe(0);
  });

  it("does not absorb new findings: evaluating twice against the same baseline gives the same verdict", () => {
    const s = scan({ jwt_security: [finding({ severity: "critical" })] });
    const baseline: string[] = [];
    expect(evaluateStatic(s, baseline).newCriticalHigh).toBe(1);
    expect(evaluateStatic(s, baseline).newCriticalHigh).toBe(1);
    expect(baseline).toEqual([]);
  });

  it("counts baseline entries that are gone", () => {
    expect(evaluateStatic(scan({}), ["deadbeefdeadbeef"]).resolved).toBe(1);
  });

  it("a key scanner that errored or is missing is an error, not a pass", () => {
    const s = scan({});
    s.scanners!.idor = { status: "error", error: "boom" };
    delete s.scanners!.jwt_security;
    const g = evaluateStatic(s, []);
    expect(g.scannerErrors).toEqual(["idor: status error", "jwt_security: not in scan output"]);
    expect(staticOutputs(g).scanner_errors).toBe(2);
  });

  it("an empty scan file fails closed on every key scanner", () => {
    expect(evaluateStatic({}, []).scannerErrors).toHaveLength(KEY_SCANNERS.length);
  });

  it("ignores scanners outside the key six", () => {
    const s = scan({});
    s.scanners!.prompt_injection = { status: "ok", result: { findings: [finding({ severity: "critical" })] } };
    expect(evaluateStatic(s, []).newFindings).toHaveLength(0);
  });
});

describe("public rendering carries counts only", () => {
  const g = evaluateStatic(scan({ idor: [finding({ severity: "critical" })] }), []);

  it("redacted: no file, rule, message or fingerprint", () => {
    const md = renderStatic(g, true);
    expect(md).toContain("1 new (1 critical/high)");
    for (const leak of [SECRET_FILE, "Direct object reference", "IDOR", g.newFindings[0].hash]) expect(md).not.toContain(leak);
    expect(md).toContain("Details are withheld");
  });

  it("private/local: lists the new finding", () => {
    const md = renderStatic(g, false);
    expect(md).toContain(SECRET_FILE);
    expect(md).toContain(g.newFindings[0].hash);
  });

  it("job outputs are numbers and a bare risk word", () => {
    const out = staticOutputs(g);
    for (const [k, v] of Object.entries(out)) {
      if (k === "risk_level") expect(v).toMatch(/^[a-z]+$/);
      else expect(typeof v).toBe("number");
    }
    expect(staticOutputs({ ...g, riskLevel: "x; rm -rf /" }).risk_level).toBe("unknown");
  });

  it("the combined report accepts only digits and plain words from job outputs", () => {
    const md = renderCombined({
      staticResult: "failure",
      pentestResult: "success",
      dependencyResult: "success",
      totalFindings: "12",
      totalCritical: "1",
      riskLevel: "low",
      newFindings: SECRET_FILE,
      newCriticalHigh: "1",
      scannerErrors: "0",
      pentestRan: "true",
      pentestConfirmed: "0",
      pentestConfirmedCriticalHigh: "0",
      depHigh: "",
      depCritical: "0",
    });
    expect(md).not.toContain(SECRET_FILE);
    expect(md).toContain("12 findings, 1 critical, risk=low");
    expect(md).toContain("- high, 0 critical");
    expect(asCount("7")).toBe("7");
    expect(asCount("7 files")).toBe("-");
  });
});

describe("evaluatePentest", () => {
  it("reads phase2, not the summary key the report never had", () => {
    expect(evaluatePentest({ summary: { total_critical: 0 }, phase2: { findings: [{ confirmed: true, severity: "critical" }], confirmed_vulnerabilities: 1 } })).toEqual({
      ran: true,
      findings: 1,
      confirmed: 1,
      confirmedCriticalHigh: 1,
    });
  });

  it("unconfirmed candidates do not gate", () => {
    const g = evaluatePentest({ phase2: { findings: [{ confirmed: false, severity: "critical" }, { status: "false_positive" }], confirmed_vulnerabilities: 0 } });
    expect(g).toEqual({ ran: true, findings: 2, confirmed: 0, confirmedCriticalHigh: 0 });
  });

  it("a confirmed count without per-finding severity still gates", () => {
    expect(evaluatePentest({ phase2: { confirmed_vulnerabilities: 2 } }).confirmedCriticalHigh).toBe(2);
  });

  it("no phase2 means it did not run", () => {
    expect(evaluatePentest({ phase1: {}, phase2: null }).ran).toBe(false);
    expect(evaluatePentest({ summary: { total_critical: 0 } }).ran).toBe(false);
    expect(evaluatePentest(null).ran).toBe(false);
  });
});

describe("baseline", () => {
  it("is built from the key scanners only, sorted, with a note", () => {
    const s = scan({ idor: [finding(), finding()], auth_bypass: [finding({ file: "b.ts" })] });
    s.scanners!.other = { status: "ok", result: { findings: [finding({ file: "z.ts" })] } };
    const b = baselineFromScan(s, "reviewed in #1", new Date("2026-10-24T00:00:00Z"));
    expect(b.total).toBe(2);
    expect(b.finding_hashes).toEqual([...b.finding_hashes].sort());
    expect(b.note).toBe("reviewed in #1");
    expect(parseBaseline(JSON.stringify(b))).toEqual(b.finding_hashes);
  });

  it("rejects a baseline with no hash list", () => {
    expect(() => parseBaseline("{}")).toThrow();
  });

  it("the committed baseline parses", () => {
    const hashes = parseBaseline(readFileSync(join(__dirname, "../../../.agenticqa/scan-baseline.json"), "utf8"));
    expect(hashes.every((h) => /^[0-9a-f]{16}$/.test(h))).toBe(true);
  });
});

describe("CLI", () => {
  const cli = join(__dirname, "../../../scripts/security/self-scan.ts");
  const tsx = (args: string[], env: Record<string, string>, cwd: string) =>
    spawnSync(process.execPath, [require.resolve("ts-node/dist/bin.js"), "--transpile-only", "--compiler-options", '{"module":"commonjs","moduleResolution":"node"}', cli, ...args], {
      cwd,
      env: { ...process.env, ...env },
      encoding: "utf8",
    });
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "self-scan-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("in a public Actions run, prints and outputs counts only", () => {
    writeFileSync(join(dir, "scan.json"), JSON.stringify(scan({ idor: [finding({ severity: "critical" })] })));
    writeFileSync(join(dir, "baseline.json"), JSON.stringify({ finding_hashes: [], total: 0, generated_at: "x" }));
    const out = join(dir, "out.txt");
    const summary = join(dir, "summary.md");
    writeFileSync(out, "");
    writeFileSync(summary, "");
    const r = tsx(["static", "--scan", "scan.json", "--baseline", "baseline.json", "--md", "r.md"], { GITHUB_ACTIONS: "true", SECURITY_REPORT_PUBLIC: "true", GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary }, dir);
    expect(r.status).toBe(0);
    const everything = r.stdout + r.stderr + readFileSync(out, "utf8") + readFileSync(summary, "utf8") + readFileSync(join(dir, "r.md"), "utf8");
    expect(everything).toContain("new_critical_high=1");
    expect(everything).not.toContain(SECRET_FILE);
    expect(everything).not.toContain("Direct object reference");
  });

  it("exits 2 when the scan file is missing or not JSON, without echoing its content", () => {
    expect(tsx(["static", "--scan", "nope.json"], {}, dir).status).toBe(2);
    writeFileSync(join(dir, "bad.json"), `{"file": "${SECRET_FILE}" oops`);
    const r = tsx(["static", "--scan", "bad.json"], {}, dir);
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).not.toContain(SECRET_FILE);
  });

  it("refuses to write the baseline from CI, and requires a note locally", () => {
    writeFileSync(join(dir, "scan.json"), JSON.stringify(scan({ idor: [finding()] })));
    expect(tsx(["baseline", "--scan", "scan.json", "--baseline", "b.json", "--note", "x"], { GITHUB_ACTIONS: "true" }, dir).status).toBe(2);
    expect(tsx(["baseline", "--scan", "scan.json", "--baseline", "b.json"], { GITHUB_ACTIONS: "" }, dir).status).toBe(2);
    const ok = tsx(["baseline", "--scan", "scan.json", "--baseline", "b.json", "--note", "reviewed"], { GITHUB_ACTIONS: "" }, dir);
    expect(ok.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "b.json"), "utf8")).total).toBe(1);
  });
});
