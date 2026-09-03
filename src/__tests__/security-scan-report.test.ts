/**
 * The security-scan report + gate must agree, and must tell the truth.
 *
 * THE FAILURE THIS CLOSES. The AgenticQA scan comment computed each scanner's
 * Status as `PASS if raw_critical == 0 else FAIL`, but the pipeline gate fails
 * only on findings NOT in the committed baseline. So a persistent, known
 * finding made the table shout "Auth Bypass ... FAIL" and "risk=critical, 74
 * critical" on every green PR, while the gate passed and the PR merged. The
 * banner and the gate disagreed, and the banner was the one a client saw.
 *
 * scripts/security-scan-report.py is now the single computation behind both the
 * table and the gate. These tests pin the three behaviors that matter:
 *   1. Verified false positives in suppressions.json are dropped → the row is
 *      not red just because a public/login route exists.
 *   2. A NEW, unsuppressed critical still FAILS the gate (exit 1). Recall of
 *      real vulnerabilities is preserved — the suppression list cannot hide one.
 *   3. A critical already in the baseline does NOT fail the gate, because the
 *      pipeline does not fail on baseline findings. Report == gate.
 *
 * The script is invoked as a subprocess (python3, present in CI and locally)
 * against temp fixtures, so this exercises the real file the workflow runs.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.join(process.cwd(), "scripts", "security-scan-report.py");
const SUPPRESSIONS = path.join(process.cwd(), ".agenticqa", "suppressions.json");

function run(
  scan: unknown,
  baselineHashes: string[],
  gate = true,
): { code: number; out: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scanrep-"));
  const scanFile = path.join(dir, "scan.json");
  const baseFile = path.join(dir, "baseline.json");
  fs.writeFileSync(scanFile, JSON.stringify(scan));
  fs.writeFileSync(baseFile, JSON.stringify({ finding_hashes: baselineHashes }));
  const args = [SCRIPT, scanFile, "--baseline", baseFile,
    "--suppressions", SUPPRESSIONS];
  if (gate) args.push("--gate");
  try {
    const out = execFileSync("python3", args, { encoding: "utf8" });
    return { code: 0, out };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A scan whose only gate-scanner findings are the three verified auth FPs. */
function scanWithAuthFPs(extra: Record<string, unknown[]> = {}) {
  const empty = { status: "ok", result: { findings: [] as unknown[] } };
  const scanners: Record<string, unknown> = {
    idor: { ...empty }, jwt_security: { ...empty }, rate_limit: { ...empty },
    error_disclosure: { ...empty }, security_headers: { ...empty },
    auth_bypass: {
      status: "ok",
      result: {
        findings: [
          { file: "src/app/api/version/route.ts", severity: "high", message: "GET handler has no authentication check" },
          { file: "src/app/api/agents/token/route.ts", severity: "critical", message: "POST handler has no authentication check" },
          { file: "src/app/api/site-analytics/ingest/route.ts", severity: "critical", message: "POST handler has no authentication check" },
        ],
      },
    },
  };
  for (const [k, findings] of Object.entries(extra)) {
    scanners[k] = { status: "ok", result: { findings } };
  }
  return { summary: { total_findings: 2113, total_critical: 74, risk_level: "critical" }, scanners };
}

describe("security-scan-report", () => {
  it("suppresses the three verified auth false positives and passes", () => {
    const { code, out } = run(scanWithAuthFPs(), []);
    expect(code).toBe(0);
    expect(out).toMatch(/Auth Bypass \| 0 \| 0 \|.*3 suppressed.*\| PASS/);
    expect(out).toMatch(/→ PASS/);
  });

  it("still FAILS the gate on a NEW unsuppressed critical (recall preserved)", () => {
    const scan = scanWithAuthFPs({
      idor: [{ file: "src/app/api/clients/[id]/route.ts", severity: "critical", message: "IDOR: path id used without ownership check" }],
    });
    const { code, out } = run(scan, []);
    expect(code).toBe(1);
    expect(out).toMatch(/Idor \| 1 \| 1 \|.*\| FAIL/);
    expect(out).toMatch(/1 new .*critical/i);
  });

  it("does NOT fail on a critical that is already in the baseline (report == gate)", () => {
    const finding = { file: "src/app/api/clients/[id]/route.ts", severity: "critical", message: "IDOR: path id used without ownership check" };
    const scan = scanWithAuthFPs({ idor: [finding] });
    // fingerprint: sha256("file||rule|normalized message")[:16], rule/cwe empty.
    const crypto = require("node:crypto");
    const snippet = finding.message.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 160);
    const basis = `${finding.file}|||${snippet}`;
    const hash = crypto.createHash("sha256").update(basis).digest("hex").slice(0, 16);
    const { code, out } = run(scan, [hash]);
    expect(code).toBe(0);
    expect(out).toMatch(/→ PASS/);
  });

  it("labels the advisory totals as non-gating, not as the risk verdict", () => {
    const { out } = run(scanWithAuthFPs(), []);
    expect(out).toMatch(/not gating.*2113 findings.*74 critical/);
  });
});
