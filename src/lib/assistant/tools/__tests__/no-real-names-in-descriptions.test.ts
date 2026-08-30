/**
 * A capability list a client reads must not name our colleagues.
 *
 * WHAT WAS THERE. get_related_records described itself as "Find records
 * related to a person or company (Acme's opportunities, Jorge's deals,
 * contacts for Acme)". Jorge is a colleague, and he was the ONLY person named
 * anywhere in the catalogue, so the line did not read as an example. It read
 * as the product having been built around one company's staff, and a client
 * seeing somebody else's employee in a capability list reasonably wonders
 * whose data is in there.
 *
 * These strings are user-visible: "what can you do" prints them, which is the
 * first screen many people ever see.
 *
 * NARROW BY DESIGN. It bans a specific, known-bad set rather than trying to
 * detect names in general. A general detector would flag GitHub, SharePoint
 * and Azure Document Intelligence, and a guard that cries wolf gets deleted.
 * Add to the list when a new name gets written down.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const TOOLS_DIR = "src/lib/assistant/tools";

/** Real people and stand-in companies that have appeared in these strings. */
const NAMES = [
  "Jorge",
  "Acme",
  "Susie",
  "Aidan",
  "Nick Homyk",
  "Agent1",
  "Scout",
];

function toolFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...toolFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Only the user-visible description strings, not comments or code. */
function descriptions(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const file of toolFiles(TOOLS_DIR)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/^\s*description:\s*\n?\s*"((?:[^"\\]|\\.)*)"/gm)) {
      out.push({ file, text: m[1] });
    }
  }
  return out;
}

describe("tool descriptions are safe to show a client", () => {
  it("finds descriptions to check, so this cannot pass by scanning nothing", () => {
    expect(descriptions().length).toBeGreaterThan(30);
  });

  it.each(NAMES)("no description names %s", (name) => {
    const offenders = descriptions()
      .filter((d) => new RegExp(`\\b${name}\\b`).test(d.text))
      .map((d) => `${d.file}: ${d.text.slice(0, 80)}`);
    expect(offenders).toEqual([]);
  });

  /* The replacement must still say what the tool matches, or removing the
     name has cost a reader the meaning. */
  it("get_related_records still explains itself by role", () => {
    const src = readFileSync(join(TOOLS_DIR, "get-related-records-tool.ts"), "utf8");
    expect(src).toMatch(/an account's open opportunities/);
    expect(src).toMatch(/a rep's deals/);
  });
});
