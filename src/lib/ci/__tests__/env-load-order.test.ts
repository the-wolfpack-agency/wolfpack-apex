/**
 * A script must not call dotenv's config() and then statically import.
 *
 * Imports are hoisted, so every imported module is evaluated BEFORE any
 * statement in the importing file. A script written the obvious way loads
 * db.ts first, which captures an empty DATABASE_URL into its pool config, and
 * every query afterwards fails.
 *
 * What makes it hard to see is that it looks fine: by the time the script's
 * own body runs the env IS populated, so a guard reading
 * process.env.DATABASE_URL passes and the failure surfaces much later as a
 * connection error. The mapper shipped like this, walked a client system for
 * 216 seconds, printed a complete map and stored none of it.
 *
 * scripts/load-env.ts fixes it by being a side-effect import, since the
 * relative order of imports IS preserved.
 */
import fs from "node:fs";
import path from "node:path";

const SCRIPTS = path.resolve(__dirname, "..", "..", "..", "..", "scripts");

/** Statements that read env at module load in something they import. */
const INLINE_CONFIG = /^\s*config\(\s*\{[^}]*path\s*:/m;
const STATIC_IMPORT = /^\s*import\s+(?!type\b)[^;]*?from\s+["'][^"']+["']/m;

function scriptsWithInlineDotenv(): { file: string; source: string }[] {
  if (!fs.existsSync(SCRIPTS)) return [];
  return fs
    .readdirSync(SCRIPTS)
    .filter((f) => /\.ts$/.test(f) && f !== "load-env.ts")
    .map((f) => ({ file: f, source: fs.readFileSync(path.join(SCRIPTS, f), "utf-8") }))
    .filter((f) => INLINE_CONFIG.test(f.source));
}

describe("scripts load their environment before anything reads it", () => {
  it("no script calls dotenv config() with a static import after it", () => {
    const offenders = scriptsWithInlineDotenv().filter((f) => {
      const after = f.source.slice(f.source.search(INLINE_CONFIG));
      return STATIC_IMPORT.test(after);
    });

    if (offenders.length > 0) {
      throw new Error(
        `These scripts call dotenv config() and then import statically, so the\n` +
          `imported modules already read an empty process.env:\n` +
          offenders.map((o) => `  scripts/${o.file}`).join("\n") +
          `\n\nReplace the config() call with:  import "./load-env";  as the FIRST import.\n` +
          `A dynamic  await import(...)  inside a function is also fine.`,
      );
    }
    expect(offenders).toEqual([]);
  });

  /* The helper must keep doing the one thing it exists for. */
  it("load-env actually loads .env.local", () => {
    const src = fs.readFileSync(path.join(SCRIPTS, "load-env.ts"), "utf-8");
    expect(src).toMatch(/config\(\s*\{\s*path:\s*["']\.env\.local["']/);
  });

  /* The scan finding no scripts at all would mean it broke rather than that
     the problem is solved. */
  it("is actually looking at the scripts directory", () => {
    expect(fs.readdirSync(SCRIPTS).filter((f) => /\.ts$/.test(f)).length).toBeGreaterThan(5);
  });
});
