/**
 * The estate sync must never reach the assistant, retrieval, or the UI.
 *
 * The promise made when this was built was that indexing more documents cannot
 * change an answer that already works or alter any rendered surface, because
 * the feature lives entirely in the ingest/connector path. A promise in a
 * comment rots; this test enforces it. If a future edit imports the router, the
 * gate, retrieval, or a React component into the estate-sync module or its
 * route, this fails — the coupling has to be deliberate and visible, not
 * accidental.
 */

import fs from "node:fs";
import path from "node:path";

const FILES = [
  "src/lib/connectors/sharepoint/sync-all.ts",
  "src/app/api/connectors/sharepoint/sync-all/route.ts",
];

/** Import specifiers that would mean the ingest path had reached into the
 *  answer path or the UI. Deliberately broad. */
const FORBIDDEN =
  /from\s+["']@\/(lib\/assistant|lib\/search|lib\/rag-providers|lib\/qdrant|components)\b|from\s+["'][^"']*\.tsx["']/;

describe("estate sync stays in the ingest path", () => {
  it.each(FILES)("%s imports nothing from the assistant/retrieval/UI", (rel) => {
    const src = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    const offending = src
      .split("\n")
      .filter((l) => l.trimStart().startsWith("import") && FORBIDDEN.test(l));
    expect(offending).toEqual([]);
  });
});
