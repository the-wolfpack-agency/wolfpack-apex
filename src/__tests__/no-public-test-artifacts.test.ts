/**
 * This repository is PUBLIC: any signed-in GitHub user can download its Actions
 * artifacts. A Playwright trace records every request with its cookies, so a
 * live-site E2E run that uploaded its trace published a CTO-role session
 * (instinct_access_token + a 7-day instinct_refresh_token) on 2026-10-20.
 * Screenshots, videos and reports of live pages carry real client data too.
 *
 * Rule: an upload-artifact step that ships Playwright output (report, traces,
 * screenshots, test-results, failure dumps, logs) or tool scan output must be
 * gated on github.event.repository.private. The failing test name and error
 * still surface through the github reporter in the run log.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WF_DIR = join(__dirname, "../../.github/workflows");
const SENSITIVE = /playwright-report|(?<!pen)test-results|test-failures|screenshots|playwright-output\.log|\/tmp\/tool-results/;
const GATE = "github.event.repository.private";

function uploadSteps(src: string): string[] {
  return src.split(/(?=\n\s+- (?:name|uses):)/).filter((st) => st.includes("uses: actions/upload-artifact"));
}

describe("no Playwright or tool output is uploaded from a public repository", () => {
  const files = readdirSync(WF_DIR).filter((n) => /\.ya?ml$/.test(n));

  it("every sensitive upload-artifact step is gated on the repository being private", () => {
    const ungated: string[] = [];
    let sensitive = 0;
    for (const n of files) {
      for (const st of uploadSteps(readFileSync(join(WF_DIR, n), "utf8"))) {
        if (!SENSITIVE.test(st)) continue;
        sensitive++;
        const cond = /\n\s+if: ([^\n]+)/.exec(st)?.[1] ?? "";
        if (!cond.includes(GATE)) ungated.push(`${n}: ${/\n\s+name: ([^\n]+)/.exec(st.split("with:")[1] ?? "")?.[1] ?? "?"}`);
      }
    }
    expect(sensitive).toBeGreaterThanOrEqual(15);
    expect(ungated).toEqual([]);
  });

  it("the check catches an ungated trace upload (positive control)", () => {
    const bad = "\n      - name: Upload Playwright report\n        if: always()\n        uses: actions/upload-artifact@x\n        with:\n          path: test-results/\n";
    const st = uploadSteps(bad)[0];
    expect(SENSITIVE.test(st)).toBe(true);
    expect((/\n\s+if: ([^\n]+)/.exec(st)?.[1] ?? "").includes(GATE)).toBe(false);
  });
});
