/**
 * The weekly ZAP + Nuclei benchmark scans our own Forcefield sites. Without the
 * synthetic header those runs were recorded as a real weekly attack burst (66% of
 * all hostile sessions, 2026-10-26). Both scanners must present the header, and
 * the workflow must pass the token.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../../../../..");
const script = readFileSync(join(ROOT, "scripts/competitive-benchmark.mjs"), "utf8");
const workflow = readFileSync(join(ROOT, ".github/workflows/competitive-benchmark.yml"), "utf8");

describe("competitive benchmark marks itself as synthetic", () => {
  it("both scanners send x-forcefield-synthetic when the token is set", () => {
    expect(script).toContain('const SYNTHETIC_HEADER = "x-forcefield-synthetic"');
    expect(script).toMatch(/"-I", \/\/ do not fail the process on warnings\n\s+\.\.\.zapSyntheticArgs\(url\),/);
    expect(script).toMatch(/"-omit-raw",\n\s+\.\.\.nucleiSyntheticArgs\(url\),/);
    expect(script).toContain("matchtype=REQ_HEADER");
  });
  it("the token only ever goes to our own Forcefield hosts, never a third-party corpus target", () => {
    expect(script).toMatch(/function zapSyntheticArgs\(url\) \{\n\s+if \(!syntheticOn \|\| !isOwnForcefieldHost\(url\)\) return \[\];/);
    expect(script).toMatch(/return syntheticOn && isOwnForcefieldHost\(url\) \?/);
    const hosts = script.match(/OWN_FORCEFIELD_HOSTS = new Set\(\[([^\]]+)\]\)/)?.[1] ?? "";
    expect(hosts.split(",").map((h) => h.trim().replace(/"/g, "")).sort()).toEqual(
      ["aidanmulready.com", "ogiam.com", "weekendwithporsche.com", "wolfpack-instinct.vercel.app", "www.aidanmulready.com", "www.ogiam.com", "www.weekendwithporsche.com"],
    );
  });
  it("the workflow passes FORCEFIELD_SYNTHETIC_TOKEN to the script", () => {
    expect(workflow).toContain("FORCEFIELD_SYNTHETIC_TOKEN: ${{ secrets.FORCEFIELD_SYNTHETIC_TOKEN }}");
  });
});
