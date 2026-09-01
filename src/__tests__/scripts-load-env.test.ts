/**
 * A script that reads the environment must load it first.
 *
 * THE FAILURE THIS CLOSES. scripts/eval-retrieval.ts refuses to run without an
 * embedding deployment, which is right: grading half the retrieval path and
 * calling the number "recall" would be wrong by construction. But it never
 * imported load-env, so it never saw .env.local, so it refused on a machine
 * where the deployment IS configured. The message sent whoever ran it looking
 * for a missing secret that was already there, and the eval sat unrunnable for
 * its whole life while looking like a deliberate guard.
 *
 * Fourteen scripts had the same hole, including every model-router one:
 * model-bakeoff, model-mix, router-exercise, prove-a-third-party-model. The
 * router has picked the same model 99.8 per cent of the time since April, and
 * the tools built to find out why could not reach a key.
 *
 * WHY THE ORDER IS ASSERTED AND NOT JUST THE PRESENCE. Imports hoist. A
 * dotenv call written above an import still runs after it, so db.ts captures
 * an undefined connection string and every query afterwards fails somewhere
 * far away from the cause. Being present is not the same as being first.
 *
 * WHAT IT DOES NOT CLAIM. A script with no env-reading import needs nothing
 * and is left alone. This looks for the reach, not for the file.
 */

import fs from "node:fs";
import path from "node:path";

const SCRIPTS = path.join(process.cwd(), "scripts");

/** Modules that read process.env while being imported. */
const READS_ENV = /from\s+"@\/lib\/(db|qdrant|neo4j|ai\/|brain\/|integrations\/)/;

/**
 * FOLLOWS THE IMPORT, BECAUSE THE FIRST VERSION DID NOT.
 *
 * It matched only DIRECT imports of an env-reading module, so a script
 * importing @/lib/releases sailed through: releases imports @/lib/db, reads
 * DATABASE_URL at module load, and the connection is refused with an empty
 * error message. publish-loc-snapshot failed exactly that way on 2026-09-01,
 * printing "[loc] failed:" and nothing after it.
 *
 * Two hops is enough for this repository and cheap. A rule that recursed
 * without a bound would follow a cycle forever, and one that stopped at zero
 * hops was the bug.
 */
function reachesEnv(modulePath: string, depth = 0): boolean {
  if (depth > 2) return false;
  for (const candidate of [`${modulePath}.ts`, `${modulePath}/index.ts`]) {
    const full = path.join(process.cwd(), "src", "lib", candidate);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, "utf8");
    if (READS_ENV.test(src)) return true;
    for (const m of src.matchAll(/from\s+"@\/lib\/([a-zA-Z0-9/_-]+)"/g)) {
      if (reachesEnv(m[1], depth + 1)) return true;
    }
  }
  return false;
}

/** True when a script reaches process.env directly or through what it imports. */
function scriptReadsEnv(source: string): boolean {
  if (READS_ENV.test(source)) return true;
  for (const m of source.matchAll(/from\s+"@\/lib\/([a-zA-Z0-9/_-]+)"/g)) {
    if (reachesEnv(m[1])) return true;
  }
  return false;
}

const scriptFiles = fs
  .readdirSync(SCRIPTS)
  .filter((f) => f.endsWith(".ts") && f !== "load-env.ts");

describe("scripts that need the environment", () => {
  it("load it, and load it first", () => {
    const broken: string[] = [];

    for (const file of scriptFiles) {
      const source = fs.readFileSync(path.join(SCRIPTS, file), "utf8");
      if (!scriptReadsEnv(source)) continue;

      const imports = source
        .split("\n")
        .map((l, i) => ({ line: l.trim(), i }))
        .filter((l) => /^import\b/.test(l.line));

      const first = imports[0];
      if (!first) continue;

      if (!/load-env/.test(first.line)) {
        broken.push(
          `scripts/${file}: first import is ${JSON.stringify(first.line)}, ` +
            `not load-env. Imports hoist, so this already read process.env.`,
        );
      }
    }

    expect(broken.join("\n")).toBe("");
  });

  /* The regex above is the whole test, so a change that stops it matching
     anything would pass silently and guard nothing. */
  it("actually matches the scripts it is meant to cover", () => {
    const covered = scriptFiles.filter((f) =>
      scriptReadsEnv(fs.readFileSync(path.join(SCRIPTS, f), "utf8")),
    );
    expect(covered.length).toBeGreaterThan(10);
  });

  /* THE HOLE THE FIRST VERSION HAD. A script importing @/lib/releases reaches
     the database through it, and matching only direct imports missed every one
     of them: eleven scripts, including the release publisher. */
  it("follows an import to find an env reader one hop away", () => {
    expect(scriptReadsEnv('import { createRelease } from "@/lib/releases";')).toBe(true);
    /* And still leaves alone a script that reaches nothing. */
    expect(scriptReadsEnv('import { readFileSync } from "node:fs";')).toBe(false);
  });
});
