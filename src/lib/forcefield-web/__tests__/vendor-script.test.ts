/**
 * @jest-environment node
 *
 * scripts/forcefield-vendor.mjs must land the core where each site actually
 * keeps it. weekendwithporsche keeps its app at the repo root (lib/), so the
 * fixed src/lib target used to create a second, unused copy there and the real
 * one had to be synced by hand.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(__dirname, "../../../..");
const SCRIPT = join(ROOT, "scripts/forcefield-vendor.mjs");
const manifest = JSON.parse(readFileSync(join(ROOT, "src/lib/forcefield-web/vendor-manifest.json"), "utf8"));

function run(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("forcefield-vendor.mjs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ff-vendor-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("defaults to the manifest targetDir for a fresh site", () => {
    expect(run([dir]).code).toBe(0);
    for (const f of manifest.files) expect(existsSync(join(dir, manifest.targetDir, f))).toBe(true);
    const marker = readFileSync(join(dir, manifest.targetDir, "VENDORED.md"), "utf8");
    expect(marker).toMatch(/Vendored from apex commit `(?:[0-9a-f]{40}|unknown)`/);
  });

  it("re-syncs an existing root lib/ copy in place and does not create src/lib", () => {
    mkdirSync(join(dir, "lib/forcefield-web"), { recursive: true });
    writeFileSync(join(dir, "lib/forcefield-web/VENDORED.md"), "old");
    expect(run([dir]).code).toBe(0);
    for (const f of manifest.files) expect(existsSync(join(dir, "lib/forcefield-web", f))).toBe(true);
    expect(existsSync(join(dir, "src/lib/forcefield-web"))).toBe(false);
  });

  it("honours an explicit --target-dir", () => {
    expect(run([dir, "--target-dir", "app/ff"]).code).toBe(0);
    expect(existsSync(join(dir, "app/ff/monitor.ts"))).toBe(true);
  });

  it("refuses a --target-dir outside the target repo", () => {
    expect(run([dir, "--target-dir", "../escape"]).code).not.toBe(0);
    expect(run([dir, "--target-dir", "/tmp/escape"]).code).not.toBe(0);
  });

  it("refuses when two vendored copies exist rather than guessing", () => {
    for (const d of ["lib/forcefield-web", "src/lib/forcefield-web"]) {
      mkdirSync(join(dir, d), { recursive: true });
      writeFileSync(join(dir, d, "VENDORED.md"), "old");
    }
    const r = run([dir]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/more than one vendored copy/);
  });
});
