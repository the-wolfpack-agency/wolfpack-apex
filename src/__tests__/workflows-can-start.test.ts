/**
 * Every workflow file must be one GitHub can actually start.
 *
 * THE FAILURE THIS CATCHES, found 2026-08-23: a step in the e2e reality-check
 * workflow had a name and an `if` and neither `run` nor `uses`, left behind by
 * a duplicated pair where the first copy was truncated. A step with nothing to
 * execute is invalid, so GitHub rejected the entire file before creating any
 * jobs.
 *
 * Every run failed instantly with "this run likely failed because of a
 * workflow file issue" and zero jobs. 100 of the last 100, going back months.
 *
 * The cost was silent and large. Specs were added to that workflow in good
 * faith, they pass locally, and not one had ever run in CI. A suite that cannot
 * fail is not coverage, and the only signal was a red badge on a job with no
 * retrievable logs, which reads as an infrastructure problem rather than a typo.
 *
 * READ AS TEXT, NOT PARSED. A YAML parser would not catch this anyway, because
 * the file IS valid YAML: it is invalid WORKFLOW, which is a different check.
 * Reading the lines also keeps this free of a new dependency, matching how
 * reality-check-workflow.test.ts already inspects these files.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const DIR = join(process.cwd(), ".github/workflows");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

interface Block {
  line: number;
  name: string;
  body: string[];
}

/**
 * Every step in a file, as the lines belonging to it.
 *
 * A step starts at a "- " inside a steps: list and runs until the next line
 * indented no further than that dash. Deliberately simple: it only has to be
 * right about whether a block contains run or uses.
 */
function stepsIn(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let inSteps = false;
  let stepsIndent = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;

    if (/^\s*steps:\s*$/.test(line)) {
      inSteps = true;
      stepsIndent = indent;
      continue;
    }
    if (!inSteps) continue;
    /* Left the steps list: a key at or above the list's own indent. */
    if (indent <= stepsIndent && !/^\s*-/.test(line)) {
      inSteps = false;
      continue;
    }
    if (!/^\s*- /.test(line)) continue;

    const dash = indent;
    const body = [line];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (next.trim() === "") {
        body.push(next);
        continue;
      }
      const nextIndent = next.length - next.trimStart().length;
      if (nextIndent <= dash) break;
      body.push(next);
    }
    blocks.push({
      line: i + 1,
      name: (body.join("\n").match(/name:\s*(.+)/)?.[1] ?? "(unnamed)").trim(),
      body,
    });
  }
  return blocks;
}

describe("every workflow can start", () => {
  it("finds workflows, and steps inside them, so this is not vacuous", () => {
    expect(FILES.length).toBeGreaterThan(5);
    const total = FILES.reduce(
      (n, f) => n + stepsIn(readFileSync(join(DIR, f), "utf8")).length,
      0,
    );
    expect(total).toBeGreaterThan(30);
  });

  it.each(FILES.map((f) => [f]))("%s has no step that does nothing", (file) => {
    const text = readFileSync(join(DIR, file), "utf8");
    const offenders = stepsIn(text)
      .filter((b) => {
        const joined = b.body.join("\n");
        return !/^\s*-?\s*(run|uses):/m.test(joined);
      })
      .map((b) => `line ${b.line}: ${b.name}`);

    expect({
      file,
      hint: "A step with neither run nor uses makes GitHub reject the whole file and create zero jobs, so every spec in it goes silently dormant.",
      offenders,
    }).toEqual(expect.objectContaining({ offenders: [] }));
  });

  it("would have caught the bug it was written for", () => {
    /* The guard checked against the shape that got past everything else, so a
       future refactor of stepsIn cannot quietly stop detecting it. */
    const broken = [
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - name: Fine",
      "        run: echo ok",
      "      - name: Broken",
      "        if: always()",
      "      - name: Also fine",
      "        uses: actions/checkout@v4",
    ].join("\n");

    const bad = stepsIn(broken).filter((b) => !/^\s*-?\s*(run|uses):/m.test(b.body.join("\n")));
    expect(bad.map((b) => b.name)).toEqual(["Broken"]);
  });
});
