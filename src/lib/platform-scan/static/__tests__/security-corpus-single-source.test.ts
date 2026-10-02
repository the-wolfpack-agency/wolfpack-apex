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
const AI_SURFACE = "src/lib/ai-surface/detect.ts";

const SHARED_SIGNATURES: { name: string; fragment: string }[] = [
  { name: "eval() call", fragment: "(?<![.\\w$])eval\\s*\\(" },
  { name: "new Function()", fragment: "new\\s+Function\\s*\\(" },
  { name: "Math.random()", fragment: "Math\\s*\\.\\s*random\\s*\\(\\s*\\)" },
  { name: "SQL keywords", fragment: "select|insert\\s+into|update|delete\\s+from|where|from" },
  { name: "TLS verify off", fragment: "rejectUnauthorized\\s*:\\s*false" },
  { name: "weak hash (MD5/SHA-1)", fragment: "createHash\\s*\\(\\s*['\"](?:md5|sha-?1)" },
  { name: "dangerouslySetInnerHTML sink", fragment: "\\bdangerouslySetInnerHTML\\b" },
  { name: "Anthropic key format", fragment: "sk-ant-[A-Za-z0-9_-]{24,}" },
  { name: "OpenAI key format", fragment: "sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}" },
  { name: "Google API key format", fragment: "AIza[0-9A-Za-z_-]{35}" },
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

  it("ai-surface/detect.ts does NOT re-declare the shared provider key formats", () => {
    const aiSurface = read(AI_SURFACE);
    const providerKeyFormats = SHARED_SIGNATURES.filter((s) => s.name.endsWith("key format"));
    const reDeclared = providerKeyFormats.filter((s) => aiSurface.includes(s.fragment)).map((s) => s.name);
    expect(reDeclared).toEqual([]);
  });

  it("every engine imports from the shared corpus", () => {
    expect(detectors).toMatch(/from "@\/lib\/platform-scan\/static\/security-corpus"/);
    expect(detect).toMatch(/from "@\/lib\/platform-scan\/static\/security-corpus"/);
    expect(read(AI_SURFACE)).toMatch(/from "@\/lib\/platform-scan\/static\/security-corpus"/);
  });
});
