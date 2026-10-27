/**
 * Forcefield Edge runs the SAME engine as every other site: edge/lib/forcefield-web
 * is a vendored copy of this directory, made by scripts/forcefield-vendor.mjs.
 * This guard fails the build the moment the two differ (an engine change here
 * that was not re-vendored, or a hand edit there), so Edge can never quietly run
 * an older or forked engine.
 *
 * Fix a failure with:  npm run forcefield:vendor:edge
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..");
const EDGE = join(__dirname, "..", "..", "..", "..", "edge", "lib", "forcefield-web");
const manifest = JSON.parse(readFileSync(join(SRC, "vendor-manifest.json"), "utf8")) as { files: string[] };

describe("edge/lib/forcefield-web is an exact vendored copy of the engine", () => {
  it("carries the VENDORED.md marker and the manifest", () => {
    expect(existsSync(join(EDGE, "VENDORED.md"))).toBe(true);
    expect(readFileSync(join(EDGE, "vendor-manifest.json"), "utf8")).toBe(readFileSync(join(SRC, "vendor-manifest.json"), "utf8"));
  });

  it("holds exactly the manifest's files (nothing missing, nothing extra)", () => {
    const present = readdirSync(EDGE).filter((f) => f.endsWith(".ts")).sort();
    expect(present).toEqual([...manifest.files].sort());
  });

  for (const file of manifest.files) {
    it(`${file} is byte-identical to the source (run npm run forcefield:vendor:edge)`, () => {
      expect(readFileSync(join(EDGE, file), "utf8")).toBe(readFileSync(join(SRC, file), "utf8"));
    });
  }
});
