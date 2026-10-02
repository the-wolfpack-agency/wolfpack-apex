/**
 * GUARDRAIL: every `playwright install-deps` step is fail-fast + non-fatal.
 *
 * install-deps shells out to apt, so it depends on the runner's package mirror.
 * When the mirror hangs, an unbounded call burns the step's whole timeout-minutes
 * and is KILLED - a fatal kill the shell `|| echo` fallback cannot catch (this
 * red-flagged #1037 with zero specs run). The GitHub ubuntu image already ships
 * the libraries chromium needs, so install-deps is a best-effort safety net, not
 * a gate: a genuinely missing library surfaces as a browser-launch failure.
 *
 * So every install-deps step must (a) be `continue-on-error: true`, and (b) bound
 * each apt attempt with `timeout` so a stuck mirror fails fast. This fails if a
 * step reintroduces an unbounded or fatal install-deps.
 */
import fs from "node:fs";
import path from "node:path";

const WF_DIR = path.resolve(__dirname, "../../.github/workflows");

interface Step {
  file: string;
  line: number;
  continueOnError: boolean;
  boundedByTimeout: boolean;
}

/** Each step whose run block invokes `playwright install-deps`, with its guards. */
function installDepsSteps(yaml: string, file: string): Step[] {
  const lines = yaml.split("\n");
  const out: Step[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*-\s/.test(lines[i])) continue; // step boundary
    const indent = lines[i].search(/\S/);
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*-\s/.test(lines[j]) && lines[j].search(/\S/) <= indent) { end = j; break; }
    }
    const block = lines.slice(i, end).join("\n");
    if (!/playwright install-deps/.test(block)) continue;
    const total = (block.match(/npx playwright install-deps/g) ?? []).length;
    const wrapped = (block.match(/timeout\s+\d+\s+npx playwright install-deps/g) ?? []).length;
    out.push({
      file: path.basename(file),
      line: i + 1,
      continueOnError: /continue-on-error:\s*true/.test(block),
      // Every install-deps invocation is prefixed with `timeout <n>` (fail-fast).
      boundedByTimeout: total > 0 && total === wrapped,
    });
  }
  return out;
}

test("every playwright install-deps step is continue-on-error and timeout-bounded (fail-fast, non-fatal)", () => {
  const files = fs.readdirSync(WF_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  const offenders: string[] = [];
  for (const f of files) {
    const yaml = fs.readFileSync(path.join(WF_DIR, f), "utf8");
    for (const step of installDepsSteps(yaml, path.join(WF_DIR, f))) {
      if (!step.continueOnError) offenders.push(`${step.file}:${step.line} (not continue-on-error)`);
      if (!step.boundedByTimeout) offenders.push(`${step.file}:${step.line} (install-deps not wrapped in timeout)`);
    }
  }
  expect(offenders).toEqual([]);
});
