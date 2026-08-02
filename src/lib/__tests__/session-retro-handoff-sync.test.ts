/**
 * The handoff scaffold's retro table must match the taxonomy it came from.
 *
 * FRICTION_TAXONOMY lives in session-retro.ts, tested, with a `meaning` and an
 * `ask` per cause. scripts/handoff-scaffold.mjs then writes that table into
 * every handoff doc — as hand-copied literal strings, because the script is
 * plain node and the taxonomy is TypeScript.
 *
 * Two copies of the same list is the DRY problem the repo's own directive names
 * outright. It does not fail loudly: adding a cause leaves the handoff table
 * quietly stale, so the one artifact a human actually fills in stops matching
 * the vocabulary everything downstream analyses. The retro then produces
 * categories nothing can aggregate.
 *
 * Importing the TS into the .mjs would mean a loader, which is a runtime
 * dependency for a formatting concern. A guardrail costs nothing at runtime,
 * matches the pattern the repo already uses for coverage and allowlists, and
 * turns silent drift into a failed build. That is the trade taken here.
 */
import fs from "node:fs";
import path from "node:path";
import { FRICTION_TAXONOMY } from "../session-retro";

const SCRIPT = path.resolve(__dirname, "..", "..", "..", "scripts", "handoff-scaffold.mjs");

describe("handoff scaffold stays in step with the friction taxonomy", () => {
  const source = fs.readFileSync(SCRIPT, "utf-8");

  it("emits a row for every cause in the taxonomy", () => {
    const missing = FRICTION_TAXONOMY.filter((entry) => !source.includes(`| ${entry.cause} |`)).map((e) => e.cause);
    expect({
      hint: "Add the row to the table in scripts/handoff-scaffold.mjs.",
      missing,
    }).toEqual({ hint: expect.any(String), missing: [] });
  });

  it("emits no row for a cause the taxonomy does not define", () => {
    // A stale row is worse than a missing one: someone ticks a category that
    // nothing downstream can aggregate, and the answer is lost.
    const known = new Set(FRICTION_TAXONOMY.map((e) => e.cause));
    const rows = [...source.matchAll(/sections\.push\("\| ([a-z-]+) \| \|/g)].map((m) => m[1]);
    const stale = rows.filter((r) => !known.has(r as (typeof FRICTION_TAXONOMY)[number]["cause"]));
    expect({ hint: "Remove the row, or add the cause to FRICTION_TAXONOMY.", stale }).toEqual({
      hint: expect.any(String),
      stale: [],
    });
  });

  it("finds rows at all, so a broken match cannot pass by finding nothing", () => {
    // A scanner that silently matches zero rows reports success forever.
    const rows = [...source.matchAll(/sections\.push\("\| ([a-z-]+) \| \|/g)];
    expect(rows.length).toBe(FRICTION_TAXONOMY.length);
  });

  it("carries the taxonomy's own guidance, not a paraphrase of it", () => {
    // The `ask` is the deliverable of the whole retro. If the doc says
    // something subtly different from the tested source, the tested one is not
    // the one anybody reads.
    const drifted = FRICTION_TAXONOMY.filter((entry) => {
      const row = source.split("\n").find((l) => l.includes(`| ${entry.cause} | |`));
      if (!row) return false; // covered by the first test
      // The scaffold shortens "Nothing. This is..." to "Nothing — ...", so a
      // Nothing-ask only has to still say Nothing.
      if (entry.ask.startsWith("Nothing")) return !row.includes("Nothing");
      return !row.includes(entry.ask);
    }).map((e) => e.cause);

    expect({ hint: "Copy the `ask` from FRICTION_TAXONOMY verbatim.", drifted }).toEqual({
      hint: expect.any(String),
      drifted: [],
    });
  });
});

describe("directive-echo", () => {
  it("exists, and is not the agent's fault", () => {
    // Restating standing rules is a prompting cost, not a mistake: the rules
    // are right, they are simply already loaded. Marking it agentFault would
    // put it in the guardrail bucket, where no prompt change would ever fix it.
    const entry = FRICTION_TAXONOMY.find((e) => e.cause === "directive-echo");
    expect(entry).toBeDefined();
    expect(entry?.agentFault).toBe(false);
    expect(entry?.ask).toMatch(/only what is DIFFERENT/);
  });
});
