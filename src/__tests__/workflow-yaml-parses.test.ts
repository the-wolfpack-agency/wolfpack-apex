/**
 * Every .github/workflows file must PARSE as YAML.
 *
 * WHY this exists (a real incident, 2026-10-02): two workflow files shipped to
 * main that GitHub rejected at startup with "this run likely failed because of a
 * workflow file issue" - zero jobs, which reads in the Actions UI like an
 * infrastructure problem, not a typo, so it hid for a long time.
 *   - sharepoint-discovery.yml: an embedded multi-line `python3 -c '...'` was
 *     de-indented to column 1, which TERMINATED the `run: |` block scalar early,
 *     so GitHub tried to parse the Python as YAML keys.
 *   - factory-live-dogfood.yml: a step `name:` contained an unquoted "foo: bar",
 *     and the embedded ": " started a nested mapping.
 *
 * The sibling guardrail workflows-can-start.test.ts reads the files as TEXT and
 * says so in its header ("A YAML parser would not catch this anyway") - it checks
 * step SHAPE, not parseability. Nothing did a real parse, which is the check that
 * matches how GitHub fails. This closes that gap: a workflow that does not parse
 * fails HERE (milliseconds, local), not silently in the Actions UI.
 *
 * Parser: js-yaml is already installed (transitively) - required untyped so this
 * needs no new dependency and no @types, per the repo's "use what's installed"
 * rule. Deterministic: a pure parse over on-disk files, no network, no model.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const { load } = require("js-yaml") as { load: (src: string) => unknown };

const DIR = join(process.cwd(), ".github", "workflows");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

describe("every workflow file parses as YAML (matches how GitHub starts a run)", () => {
  it("there is at least one workflow to check (the glob is not silently empty)", () => {
    expect(FILES.length).toBeGreaterThan(0);
  });

  it.each(FILES)("%s parses, is a mapping, and declares on + jobs", (file) => {
    const text = readFileSync(join(DIR, file), "utf8");
    // Must parse. GitHub rejects the WHOLE file if this throws (zero jobs start).
    expect(() => load(text)).not.toThrow();
    const doc = load(text);
    // A workflow is a mapping with `on` and `jobs`. A parse yielding a string or
    // array means a block scalar swallowed the document - the exact failure mode.
    expect(typeof doc).toBe("object");
    expect(doc).not.toBeNull();
    const keys = Object.keys(doc as Record<string, unknown>);
    // YAML 1.1 parses the bare key `on` as boolean true; accept either form.
    expect(keys.includes("on") || keys.includes("true")).toBe(true);
    expect(keys.includes("jobs")).toBe(true);
  });
});
