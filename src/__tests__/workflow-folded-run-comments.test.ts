/**
 * No `#` comment inside a folded `run:` scalar in any workflow.
 *
 * THE INCIDENT (found 2026-10-25): e2e-reality-check.yml listed seven specs in
 * its hard-gates step, with `#` lines explaining why each was a gate. The
 * command was a folded `run: >-` scalar, which joins its lines with spaces, so
 * the shell got one line and everything after the first `#` was a comment:
 * five specs plus --config, --workers and --reporter. The step ran two specs
 * and stayed green; the other five had never run in CI. The file parses and
 * the workflow starts, so the YAML-parse and can-start guards both passed.
 *
 * Detector: src/lib/ci/folded-run-comments.ts. Literal `run: |` blocks are not
 * affected (each line stays its own shell line).
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { findFoldedRunComments } from "@/lib/ci/folded-run-comments";

const { load } = require("js-yaml") as { load: (src: string) => unknown };

const DIR = join(process.cwd(), ".github", "workflows");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

/** The original bug, reproduced verbatim in shape. */
const ORIGINAL_BUG = `name: Fixture
on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Reality-check gates
        run: >-
          npx playwright test
          tests/e2e/a.spec.ts
          # A HARD GATE BECAUSE IT NEEDS NO CREDENTIALS
          tests/e2e/b.spec.ts
          --config=playwright.config.ts --workers=2
`;

describe("folded run: scalars carry no shell comments", () => {
  it("there are workflows to check", () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  it.each(FILES)("%s has no # inside a folded run: command", (file) => {
    const findings = findFoldedRunComments(readFileSync(join(DIR, file), "utf8"));
    expect(findings.map((f) => `${file}:${f.line} ${f.text}`)).toEqual([]);
  });
});

describe("the detector catches the original bug", () => {
  it("the fixture really is the bug: the parsed command comments out spec b and every flag", () => {
    const doc = load(ORIGINAL_BUG) as { jobs: { j: { steps: { run: string }[] } } };
    const run = doc.jobs.j.steps[0].run;
    expect(run.split("\n")).toHaveLength(1);
    const executed = run.slice(0, run.indexOf("#"));
    expect(executed).toContain("tests/e2e/a.spec.ts");
    expect(executed).not.toContain("tests/e2e/b.spec.ts");
    expect(executed).not.toContain("--config");
  });

  it("flags the comment line", () => {
    expect(findFoldedRunComments(ORIGINAL_BUG)).toEqual([
      { line: 12, text: "# A HARD GATE BECAUSE IT NEEDS NO CREDENTIALS" },
    ]);
  });

  it("flags every folded variant and a list-item run:", () => {
    for (const indicator of [">", ">-", ">+", ">2-"]) {
      const text = `steps:\n  - run: ${indicator}\n      echo a\n      # hidden\n      echo b\n`;
      expect(findFoldedRunComments(text)).toHaveLength(1);
    }
  });

  it("flags an inline shell comment (it truncates the folded line the same way)", () => {
    const text = `      - run: >-\n          npx playwright test a.spec.ts # why\n          b.spec.ts\n`;
    expect(findFoldedRunComments(text)).toHaveLength(1);
  });

  it("does not flag literal blocks, quoted #, URL fragments, or YAML comments after the scalar", () => {
    const text = [
      "      - run: |",
      "          # fine in a literal block",
      "          echo a",
      "      - run: >-",
      '          echo "a # not a comment"',
      "          curl https://x.test/page#frag",
      "      # a real YAML comment, outdented, after the scalar ended",
      "      - name: next",
    ].join("\n");
    expect(findFoldedRunComments(text)).toEqual([]);
  });
});
