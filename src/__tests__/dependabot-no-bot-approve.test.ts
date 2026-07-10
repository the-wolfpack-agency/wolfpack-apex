import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guardrail: no CI workflow may auto-APPROVE a GitHub pull request.
 *
 * A bot approval (github-actions[bot] running `gh pr review --approve`) satisfies
 * the required human-review gate without a human, which defeats the control. The
 * Dependabot automation is allowed to ENABLE auto-merge, but a person must approve.
 * Rejected 2026-07 as an anti-pattern; this test blocks its return. (The
 * AgenticQA pipeline's app-internal "approve" is a call to its own workflow API,
 * not a GitHub PR review, so it is intentionally not matched.)
 */
describe("no workflow bot-approves a GitHub PR", () => {
  const dir = join(__dirname, "..", "..", ".github", "workflows");
  const files = readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

  it("has workflow files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s does not run `gh pr review --approve`", (file) => {
    const body = readFileSync(join(dir, file), "utf8");
    expect(/gh\s+pr\s+review\s+--approve/.test(body)).toBe(false);
  });
});
