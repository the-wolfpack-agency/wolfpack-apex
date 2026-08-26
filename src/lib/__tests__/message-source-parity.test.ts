/**
 * The TypeScript union and the database constraint are the same list.
 *
 * THE BUG THIS CLOSES. chat() records a `source` on every reply. Two of the
 * values it emits, 'brain' and 'user_qa_cache', were never in the CHECK
 * constraint, so every reply from the knowledge base or the Q&A cache violated
 * it and the insert failed.
 *
 * Silently. The write is fire-and-forget, so the answer still reached the
 * person and the only evidence was a line in a server log. Production held
 * 14,068 assistant messages and not one was from either path: conversation
 * history missing its Brain answers, the learning loop blind to the surface
 * the Brain work has been aimed at, and any count of Brain usage from the
 * message table reading zero, which looks exactly like nobody using it.
 *
 * No test failed, because these are two lists and nothing compared them. That
 * is the only thing worth asserting here, and it is asserted by reading both
 * rather than by restating either: a third copy would just be a third thing to
 * drift.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..", "..");

/** Every value the union in src/lib/assistant.ts allows. */
function sourcesInCode(): string[] {
  const src = readFileSync(join(ROOT, "src/lib/assistant.ts"), "utf8");
  const decl = /export type AssistantSource =([\s\S]*?);/.exec(src);
  if (!decl) throw new Error("AssistantSource union not found in src/lib/assistant.ts");
  return Array.from(decl[1].matchAll(/"([a-z_]+)"/g)).map((m) => m[1]).sort();
}

/** Every value the newest constraint migration permits. */
function sourcesInDatabase(): string[] {
  const dir = join(ROOT, "src/db/migrations");
  const file = readdirSync(dir)
    .filter((f) => f.endsWith(".sql") && !f.endsWith(".down.sql"))
    .filter((f) => /apex_messages_source_check/.test(readFileSync(join(dir, f), "utf8")))
    .sort()
    .pop();
  if (!file) throw new Error("no migration defines apex_messages_source_check");
  const sql = readFileSync(join(dir, file), "utf8");
  const add = sql.slice(sql.lastIndexOf("ADD CONSTRAINT"));
  return Array.from(add.matchAll(/'([a-z_]+)'/g)).map((m) => m[1]).sort();
}

describe("every source the assistant records can actually be stored", () => {
  /* CONTAINMENT, NOT EQUALITY, and the direction is the whole point.
   *
   * Everything the code can emit must be storable, or the row is lost. The
   * reverse is fine and expected: the constraint still permits 'codebase',
   * 'memory' and 'cache', which no longer appear in the union but do appear on
   * historical rows. Asserting equality would force a choice between failing
   * this test and breaking old data, and it is not the property that matters.
   */
  it("everything the code emits is permitted by the database", () => {
    const permitted = new Set(sourcesInDatabase());
    const unstorable = sourcesInCode().filter((s) => !permitted.has(s));
    expect(unstorable).toEqual([]);
  });

  /* Named explicitly, because these two are the ones that were lost and a
     regression would be invisible again. */
  it.each(["brain", "user_qa_cache"])("%s is permitted", (source) => {
    expect(sourcesInDatabase()).toContain(source);
  });
});
