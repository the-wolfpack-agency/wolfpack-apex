/**
 * checkSyntax: the "does it even parse" gate. Catches the exact dogfooding
 * failure - a function truncated before its closing brace - and passes valid
 * code, while ignoring non-code files.
 */
import { checkSyntax } from "@/lib/ai-code/syntax-check";

test("catches a truncated function missing its closing brace (the dogfooding bug)", () => {
  // Verbatim shape of what the factory emitted for slug.ts: no final "}".
  const truncated = `export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');`;
  const r = checkSyntax([{ path: "src/lib/slug.ts", content: truncated }]);
  expect(r.ok).toBe(false);
  expect(r.issues[0].path).toBe("src/lib/slug.ts");
  expect(r.issues.length).toBeGreaterThan(0);
});

test("passes complete, valid TypeScript", () => {
  const valid = `export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}`;
  expect(checkSyntax([{ path: "src/lib/slug.ts", content: valid }]).ok).toBe(true);
});

test("passes valid TSX and JS", () => {
  const tsx = `export const C = () => <div>{1 + 1}</div>;`;
  const js = `module.exports = function add(a, b) { return a + b; };`;
  expect(checkSyntax([{ path: "src/C.tsx", content: tsx }, { path: "src/add.js", content: js }]).ok).toBe(true);
});

test("catches an unterminated string / unexpected token", () => {
  const bad = `export const x = "oops;\nexport const y = 2;`;
  expect(checkSyntax([{ path: "src/x.ts", content: bad }]).ok).toBe(false);
});

test("ignores non-code files (json, md) - only parses TS/JS", () => {
  const r = checkSyntax([
    { path: "package.json", content: "{ not valid json but not our concern" },
    { path: "README.md", content: "# heading with { unbalanced" },
  ]);
  expect(r.ok).toBe(true);
});

test("reports the file and a 1-based line for the error", () => {
  const bad = `const a = 1;\nfunction f( {`;
  const r = checkSyntax([{ path: "src/f.ts", content: bad }]);
  expect(r.ok).toBe(false);
  expect(r.issues[0].line).toBeGreaterThanOrEqual(1);
  expect(typeof r.issues[0].message).toBe("string");
});
