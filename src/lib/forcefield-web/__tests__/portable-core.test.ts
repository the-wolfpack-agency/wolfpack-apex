import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..");
const manifest = JSON.parse(readFileSync(join(dir, "vendor-manifest.json"), "utf8")) as {
  files: string[];
};

// The vendored core must be self-contained so it drops into ANY repo. It may only
// import from within itself (relative) - never a host-app path (@/...) or a bare
// npm package. If this fails, someone made the core non-portable; move that
// dependency out of the vendored files, not into the target repos.
describe("Forcefield vendored core is portable", () => {
  it("lists the pure files and excludes the apex-only adapters", () => {
    expect(manifest.files).toEqual(expect.arrayContaining(["classify.ts", "observe.ts", "monitor.ts", "ruleset.ts", "index.ts"]));
    expect(manifest.files).not.toContain("record.ts"); // imports @/lib/analytics
    expect(manifest.files).not.toContain("rollup.ts"); // imports @/lib/db
  });

  for (const file of manifest.files) {
    it(`${file} imports only relatively (no @/ host paths, no bare packages)`, () => {
      const src = readFileSync(join(dir, file), "utf8");
      const importFroms = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const spec of importFroms) {
        expect(spec.startsWith("./") || spec.startsWith("../")).toBe(true);
      }
    });
  }
});
