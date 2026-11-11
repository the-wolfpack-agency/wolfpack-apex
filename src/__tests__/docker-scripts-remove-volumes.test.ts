/**
 * Every script that removes a Docker container must remove its anonymous
 * volumes too (`docker rm -v` / `-fv`). `docker run postgres` creates an
 * anonymous volume for the data dir and a bare `docker rm -f` leaves it: on
 * 2026-11-11 scripts/db-test.sh had leaked 86 of them (~5 GB) and filled the
 * disk. A script that starts a detached container must remove it: a cleanup
 * trap on EXIT, or an explicit `down` command for an up/run/down script.
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..");
const DIRS = ["scripts"];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(sh|mjs|cjs|js|ts)$/.test(name)) out.push(p);
  }
  return out;
}

const scripts = DIRS.flatMap((d) => files(join(ROOT, d)));
const removeLines = (src: string) => src.split("\n").filter((l) => /\bdocker\s+rm\b/.test(l) && !l.trim().startsWith("#"));
const removesVolumes = (line: string) => /\bdocker\s+rm\b[^\n]*\s-(?:[a-z]*v[a-z]*)\b/.test(line);

describe("docker scripts never leak volumes", () => {
  it("finds the scripts it guards", () => {
    expect(scripts.some((f) => f.endsWith("db-test.sh"))).toBe(true);
  });

  it("every `docker rm` also removes the container's anonymous volumes", () => {
    const offenders = scripts.flatMap((f) =>
      removeLines(readFileSync(f, "utf8")).filter((l) => !removesVolumes(l)).map((l) => `${f.slice(ROOT.length + 1)}: ${l.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("every script that runs a detached container removes it (exit trap or a down command)", () => {
    const offenders = scripts.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /\bdocker\s+run\b[^\n]*\s-d\b/.test(src) && !/\btrap\b[^\n]*EXIT/.test(src) && !/^\s*down\)/m.test(src);
    });
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });

  it("the check catches the bug it exists for", () => {
    expect(removesVolumes(`cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }`)).toBe(false);
    expect(removesVolumes(`cleanup() { docker rm -f -v "$NAME" >/dev/null 2>&1 || true; }`)).toBe(true);
    expect(removesVolumes(`docker rm -fv "$CONTAINER"`)).toBe(true);
  });
});
