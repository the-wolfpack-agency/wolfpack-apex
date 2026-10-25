/**
 * Guardrails for .github/workflows/security-self-scan.yml, and one rule for
 * every workflow's github-script blocks. Each assertion is an incident:
 *
 * - Scheduled runs on 2026-10-11 and 2026-10-18 died with
 *   "ReferenceError: steps is not defined": `${steps.x.outputs.y}` was written
 *   inside a github-script template literal, where `steps` is an Actions
 *   expression context, not a JavaScript variable.
 * - The baseline was regenerated and committed on every push to main, so new
 *   findings were absorbed instead of failing the gate.
 * - The repository is public: `--json` printed every finding into the run
 *   log, the summary job pasted the raw scan JSON into the job summary and PR
 *   comment, and the result files were uploaded as artifacts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WF_DIR = join(__dirname, "../../.github/workflows");
// Comment lines removed: the workflow's comments describe the old behavior.
const SELF_SCAN = readFileSync(join(WF_DIR, "security-self-scan.yml"), "utf8")
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");

/** Bodies of every `script: |` block (github-script), by indentation. */
function scriptBlocks(src: string): string[] {
  const lines = src.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)script:\s*\|/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() !== "" && l.length - l.trimStart().length <= indent) break;
      body.push(l);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

/** `${steps.` etc. that is not `${{ ... }}`: a ReferenceError at run time. */
const JS_CONTEXT_REF = /\$\{\s*(steps|needs|inputs|secrets|vars|matrix|jobs|runner|env)\./;

function jobBlock(src: string, job: string): string {
  const start = src.indexOf(`\n  ${job}:\n`);
  if (start < 0) throw new Error(`job ${job} not found`);
  const rest = src.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe("github-script blocks never reference Actions contexts as JS variables", () => {
  it("no ${steps.|needs.|inputs.|...} inside any script block, in any workflow", () => {
    const bad: string[] = [];
    for (const n of readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f))) {
      for (const b of scriptBlocks(readFileSync(join(WF_DIR, n), "utf8"))) {
        const m = JS_CONTEXT_REF.exec(b);
        if (m) bad.push(`${n}: ${m[0]}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("catches the 2026-10-18 shape (positive control)", () => {
    const wf = "      - uses: actions/github-script@x\n        with:\n          script: |\n            const t = `Scan: ${steps.report.outputs.total_critical}`;\n      - name: next\n";
    const blocks = scriptBlocks(wf);
    expect(blocks).toHaveLength(1);
    expect(JS_CONTEXT_REF.test(blocks[0])).toBe(true);
    expect(JS_CONTEXT_REF.test("const t = `${{ steps.a.outputs.b }}`; const u = `${process.env.X}`;")).toBe(false);
  });
});

describe("security-self-scan.yml", () => {
  it("never writes or commits the baseline from CI", () => {
    expect(SELF_SCAN).not.toMatch(/git\s+(push|commit)/);
    expect(SELF_SCAN).not.toMatch(/contents:\s*write/);
    expect(SELF_SCAN).not.toMatch(/self-scan\.ts\s+baseline/);
    expect(SELF_SCAN).toContain("self-scan.ts static --scan scan-results.json --baseline .agenticqa/scan-baseline.json");
  });

  it("does not print scanner JSON into the public log", () => {
    // Each scanner command with its backslash continuations.
    const cmds = SELF_SCAN.match(/scripts\/(?:run_client_scan|self_hack)\.py(?:[^\n]*\\\n)*[^\n]*/g) ?? [];
    expect(cmds).toHaveLength(2);
    for (const c of cmds) {
      expect(c).toContain("--output");
      expect(c).not.toMatch(/--json\b/);
    }
    expect(SELF_SCAN).toMatch(/--output scan-results\.json > \/dev\/null/);
    expect(SELF_SCAN).toMatch(/--output pentest-results\.json > \/dev\/null/);
  });

  it("the gate states whether the repository is private (fail closed)", () => {
    expect(SELF_SCAN).toContain("SECURITY_REPORT_PUBLIC: ${{ github.event.repository.private && 'false' || 'true' }}");
  });

  it("the summary job downloads nothing and pastes no scan JSON", () => {
    const summary = jobBlock(SELF_SCAN, "scan-summary");
    expect(summary).not.toContain("download-artifact");
    expect(summary).not.toMatch(/json\.dumps|scan_data|```json/);
    expect(summary).toContain("self-scan.ts combine");
  });

  it("job outputs that cross into the summary are counts from the gate steps", () => {
    for (const job of ["static-scan", "pentest-validation", "dependency-audit"]) {
      const block = jobBlock(SELF_SCAN, job);
      const outputs = /\n {4}outputs:\n((?: {6}.+\n)+)/.exec(block)?.[1] ?? "";
      expect(outputs).not.toBe("");
      for (const line of outputs.trimEnd().split("\n")) {
        expect(line).toMatch(/^\s+[a-z_]+: \$\{\{ steps\.(gate|parse|pat-check)\.outputs\.[a-z_]+ \}\}$/);
      }
    }
  });

  it("every upload in this workflow is gated on the repository being private", () => {
    const uploads = SELF_SCAN.split(/(?=\n\s+- (?:name|uses):)/).filter((st) => st.includes("uses: actions/upload-artifact"));
    expect(uploads).toHaveLength(3);
    for (const st of uploads) expect(/\n\s+if: ([^\n]+)/.exec(st)?.[1] ?? "").toContain("github.event.repository.private");
  });

  it("fails on new critical/high, on a silent scanner, and on a pentest that did not run", () => {
    expect(SELF_SCAN).toContain("steps.gate.outputs.new_critical_high != '0' || steps.gate.outputs.scanner_errors != '0'");
    expect(SELF_SCAN).toContain("steps.gate.outputs.pentest_ran != 'true'");
    expect(SELF_SCAN).not.toContain("summary\", {}).get(\"total_critical\"");
  });

  it("keeps workflow_dispatch so a branch can be verified on demand", () => {
    expect(SELF_SCAN).toMatch(/\n {2}workflow_dispatch:/);
  });
});
