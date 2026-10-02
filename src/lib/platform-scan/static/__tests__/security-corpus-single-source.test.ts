/**
 * GUARDRAIL: the security pattern signatures are defined in ONE place.
 *
 * This test is the deterministic control for a real incident: the same CWE
 * signature (eval, new Function, SQL interpolation, Math.random, TLS-verify-off)
 * was independently declared in BOTH the diff-line gate (ai-code/detect.ts) AND
 * the whole-file scanner (platform-scan/static/detectors.ts). Two copies drift:
 * a fix or precision tweak in one did not reach the other. The patterns now live
 * once in security-corpus.ts and both engines import them.
 *
 * This guard fails if either engine RE-DECLARES one of the shared signatures as a
 * local regex literal instead of importing it - i.e. if the duplication starts to
 * creep back. It is intentionally textual (reads the source): a regex literal
 * copied back into one of these files is exactly what we must catch, and only
 * source inspection sees it.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../../../../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const DETECTORS = "src/lib/platform-scan/static/detectors.ts";
const DETECT = "src/lib/ai-code/detect.ts";
const CORPUS = "src/lib/platform-scan/static/security-corpus.ts";

/**
 * Distinctive source fragments of each single-sourced regex. Each must appear in
 * the corpus and in NEITHER engine (both reference the exported pattern instead).
 */
const SHARED_SIGNATURES: { name: string; fragment: string }[] = [
  { name: "eval() call", fragment: "(?<![.\\w$])eval\\s*\\(" },
  { name: "new Function()", fragment: "new\\s+Function\\s*\\(" },
  { name: "Math.random()", fragment: "Math\\s*\\.\\s*random\\s*\\(\\s*\\)" },
  { name: "SQL keywords", fragment: "select|insert\\s+into|update|delete\\s+from|where|from" },
  { name: "TLS verify off", fragment: "rejectUnauthorized\\s*:\\s*false" },
];

describe("security signatures are single-sourced in security-corpus.ts", () => {
  const corpus = read(CORPUS);
  const detectors = read(DETECTORS);
  const detect = read(DETECT);

  it("the corpus declares every shared signature", () => {
    for (const s of SHARED_SIGNATURES) {
      expect(corpus.includes(s.fragment)).toBe(true);
    }
  });

  it("detectors.ts does NOT re-declare any shared signature locally", () => {
    const reDeclared = SHARED_SIGNATURES.filter((s) => detectors.includes(s.fragment)).map((s) => s.name);
    expect(reDeclared).toEqual([]);
  });

  it("detect.ts does NOT re-declare any shared signature locally", () => {
    const reDeclared = SHARED_SIGNATURES.filter((s) => detect.includes(s.fragment)).map((s) => s.name);
    expect(reDeclared).toEqual([]);
  });

  it("both engines import from the shared corpus", () => {
    expect(detectors).toMatch(/from "@\/lib\/platform-scan\/static\/security-corpus"/);
    expect(detect).toMatch(/from "@\/lib\/platform-scan\/static\/security-corpus"/);
  });
});
