/** @jest-environment node */
/**
 * Every figure a client sees is about THEIR estate.
 *
 * WHY THIS IS A GUARDRAIL AND NOT A UNIT TEST. This tenant holds work for
 * several clients. Nineteen SharePoint sites are reachable and two were
 * connected, so almost everything we had been given was invisible. Connecting
 * the rest is right, and the moment it happens every unscoped count on a
 * client-facing page becomes false in the way that is hardest to notice: the
 * sentence still reads like a fact about them.
 *
 * The same defect was fixed once already on 2026-09-01, when the passage count
 * was including our own platform-scan output and had to be corrected to
 * exclude it. That was one estate leaking into a client's figure. Nine more
 * clients is the general case, and it will not be caught by review, because a
 * query that forgets the predicate looks exactly like one that does not need
 * it.
 *
 * So this reads the source. It is deliberately crude: it asserts that any
 * client-facing read of the library mentions the estate column at all. A test
 * that tried to understand the SQL would be a second SQL parser to maintain,
 * and the failure it guards against is forgetting entirely, not subtlety.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PILOT_DIR = join(__dirname, "..");

/** Files whose queries end up in front of a client. */
const CLIENT_FACING = ["phase-one.ts", "library-questions.ts"];

/** Reads that are deliberately NOT estate-scoped, each with its reason. */
const UNSCOPED_BY_DESIGN: Record<string, string> = {
  /* A scan we recovered is a scan we recovered, whoever put the file there.
     This counts a repair that happened, not a client's holdings. */
  "brain.document_ocred": "counts a repair, not a library",
};

function sqlBlocksIn(source: string): string[] {
  /* Template literals containing a FROM, which is every query here. */
  return [...source.matchAll(/`([^`]*\bFROM\b[^`]*)`/gi)].map((m) => m[1]);
}

describe("client-facing library reads name the estate", () => {
  it.each(CLIENT_FACING)("%s scopes every read of the library", (file) => {
    const source = readFileSync(join(PILOT_DIR, file), "utf8");
    const offenders = sqlBlocksIn(source)
      .filter((sql) => /\bbrain_documents\b|\bbrain_chunks\b/i.test(sql))
      .filter((sql) => !/\bestate\b/i.test(sql))
      .filter((sql) => !Object.keys(UNSCOPED_BY_DESIGN).some((k) => sql.includes(k)));

    /* Printed in full rather than counted: the point of failing is to show
       which query would report another client's documents as this one's. */
    expect(offenders.map((s) => s.replace(/\s+/g, " ").trim().slice(0, 120))).toEqual([]);
  });

  /* A new file in this directory that queries the library will not be in the
     list above, so the list itself has to be checked against reality. */
  it("has not missed a file that queries the library", () => {
    const querying = readdirSync(PILOT_DIR)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => {
        const s = readFileSync(join(PILOT_DIR, f), "utf8");
        return /\bFROM\s+brain_(documents|chunks)\b/i.test(s);
      });
    /* Anything here and not in CLIENT_FACING is either newly client-facing and
       must be added, or internal and should say so. */
    expect(querying.sort()).toEqual(CLIENT_FACING.sort());
  });

  /* The constant exists so a forgotten filter is visible as a missing import
     rather than as a plausible-looking query. */
  it("reads the estate from one place", async () => {
    const { PILOT_ESTATE } = await import("../phase-one");
    expect(PILOT_ESTATE).toBe("pcna");
  });
});
