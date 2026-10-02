/**
 * GUARDRAIL: a diagnostic artifact upload must never fail a CI job.
 *
 * Twice in one day a GREEN test run was reported red because a step AFTER the
 * tests flaked on the network: `actions/upload-artifact` returned
 * "CreateArtifact: ETIMEDOUT" (#1036), and the Chromium apt install-deps step
 * burned its whole timeout and was killed (#1037). The tests had passed; the
 * upload/instal of diagnostics is best-effort and must not gate a merge.
 *
 * This fails if any `actions/upload-artifact` step in a workflow lacks
 * `continue-on-error: true`. Uploads are diagnostics (reports, traces, results);
 * a transient artifact-service timeout is noise, not a build failure. A step that
 * genuinely must be fatal can be added to ALLOWLIST with a reason.
 */
import fs from "node:fs";
import path from "node:path";

const WF_DIR = path.resolve(__dirname, "../../.github/workflows");

/** upload-artifact steps that are intentionally fatal (none today). */
const ALLOWLIST: { file: string; reason: string }[] = [];

interface Step {
  file: string;
  line: number;
  text: string;
  hasContinueOnError: boolean;
}

/** Find each `uses: actions/upload-artifact` step and whether its step block
 *  carries `continue-on-error: true`. A step block runs from one list item
 *  (`- name:` / `- uses:`) to the next at the same indent. */
function uploadSteps(file: string, yaml: string): Step[] {
  const lines = yaml.split("\n");
  const steps: Step[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/uses:\s*actions\/upload-artifact(@|\s|$)/.test(lines[i])) continue;
    // The step starts at the nearest preceding list item (`- `) at a lower indent.
    const usesIndent = lines[i].search(/\S/);
    let start = i;
    for (let j = i; j >= 0; j--) {
      if (/^\s*-\s/.test(lines[j]) && lines[j].search(/\S/) <= usesIndent) {
        start = j;
        break;
      }
    }
    // The step ends at the next list item at the same-or-lower indent.
    const startIndent = lines[start].search(/\S/);
    let end = lines.length;
    for (let j = start + 1; j < lines.length; j++) {
      if (/^\s*-\s/.test(lines[j]) && lines[j].search(/\S/) <= startIndent) {
        end = j;
        break;
      }
    }
    const block = lines.slice(start, end).join("\n");
    steps.push({
      file: path.basename(file),
      line: start + 1,
      text: block,
      hasContinueOnError: /continue-on-error:\s*true/.test(block),
    });
  }
  return steps;
}

test("every actions/upload-artifact step is continue-on-error (a diagnostic upload can't fail a green job)", () => {
  const files = fs.readdirSync(WF_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const offenders: string[] = [];
  for (const f of files) {
    const yaml = fs.readFileSync(path.join(WF_DIR, f), "utf8");
    for (const step of uploadSteps(path.join(WF_DIR, f), yaml)) {
      if (step.hasContinueOnError) continue;
      if (ALLOWLIST.some((a) => a.file === step.file)) continue;
      offenders.push(`${step.file}:${step.line}`);
    }
  }
  expect(offenders).toEqual([]);
});
