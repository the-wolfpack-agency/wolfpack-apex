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

const scriptFiles = fs
  .readdirSync(SCRIPTS)
  .filter((f) => f.endsWith(".ts") && f !== "load-env.ts");

describe("scripts that need the environment", () => {
  it("load it, and load it first", () => {
    const broken: string[] = [];

    for (const file of scriptFiles) {
      const source = fs.readFileSync(path.join(SCRIPTS, file), "utf8");
      if (!READS_ENV.test(source)) continue;

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
      READS_ENV.test(fs.readFileSync(path.join(SCRIPTS, f), "utf8")),
    );
    expect(covered.length).toBeGreaterThan(10);
  });
});
