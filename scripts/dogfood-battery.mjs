#!/usr/bin/env node
/**
 * Dogfood BATTERY - a repeatable acceptance test that drives the deployed Agent
 * Gates and asserts each verdict path, so every scenario is pre-built and
 * verified before a client ever hits it. Fails we find here are fails the client
 * never sees.
 *
 * It exercises the FAST, deterministic gate verdicts (no CI wait): safe-review on
 * crafted diffs (allow / deny / require_human) and the compliance/transparency
 * guarantees (data-kept-from-model, secret scrub). The slow pipeline auto_fix
 * scenarios live in scripts/dogfood-ci-fix.mjs --prompt.
 *
 *   FACTORY_EMAIL=... FACTORY_PASSWORD=... node scripts/dogfood-battery.mjs
 *
 * Exit 0 if every scenario matched its expected verdict, 1 otherwise.
 */
const BASE = process.env.INSTINCT_URL || "https://wolfpack-instinct.vercel.app";
const EMAIL = process.env.FACTORY_EMAIL;
const PASSWORD = process.env.FACTORY_PASSWORD;
if (!EMAIL || !PASSWORD) { console.error("set FACTORY_EMAIL and FACTORY_PASSWORD"); process.exit(2); }

const CLEAN = "diff --git a/src/lib/util.ts b/src/lib/util.ts\n--- /dev/null\n+++ b/src/lib/util.ts\n@@ -0,0 +1,2 @@\n+export function add(a: number, b: number): number { return a + b; }\n";
const SECRET = "diff --git a/src/lib/client.ts b/src/lib/client.ts\n--- /dev/null\n+++ b/src/lib/client.ts\n@@ -0,0 +1,2 @@\n+const apiKey = \"sk-ant-abcdefghijklmnopqrstuvwxyz1234567890\";\n+export const client = { apiKey };\n";
const LOGGED_SECRET = "diff --git a/src/app/reset.ts b/src/app/reset.ts\n--- /dev/null\n+++ b/src/app/reset.ts\n@@ -0,0 +1,2 @@\n+export function onReset(resetUrl: string) { console.log(`reset link: ${resetUrl}`); }\n";

/** Each scenario: run <gate> with <input>/<policy>, expect a verdict in <accept>.
 *  accept is a SET because a finding can legitimately be deny OR require_human
 *  depending on severity; the battery reports the actual verdict either way. */
const SCENARIOS = [
  { name: "safe-review: clean change", gate: "safe-review", input: { diff: CLEAN }, policy: { frameworks: ["SOC2"], allowModelData: "none" }, accept: ["allow"] },
  { name: "safe-review: hardcoded provider key", gate: "safe-review", input: { diff: SECRET }, policy: { frameworks: ["SOC2"], allowModelData: "none" }, accept: ["deny", "require_human"] },
  { name: "safe-review: secret written to a log", gate: "safe-review", input: { diff: LOGGED_SECRET }, policy: { frameworks: ["SOC2"], allowModelData: "none" }, accept: ["deny", "require_human"] },
  // capstone gates:
  { name: "preview-verify: a healthy URL serves", gate: "preview-verify", input: { url: BASE }, policy: { frameworks: ["SOC2"], allowModelData: "none" }, accept: ["allow"] },
  { name: "preview-verify: an unreachable preview", gate: "preview-verify", input: { url: "https://nonexistent.invalid.wolfpack" }, policy: { frameworks: ["SOC2"], allowModelData: "none" }, accept: ["require_human"] },
  { name: "prod-promote: the one human touchpoint", gate: "prod-promote", input: { previewUrl: BASE, evidence: "battery" }, policy: { frameworks: ["SOC2"], allowModelData: "none" }, accept: ["require_human"] },
  // generality: a NON-code gate on the same runtime
  { name: "data-egress: clean text is safe to send", gate: "data-egress", input: { text: "summarize the roadmap" }, policy: { frameworks: ["GDPR"], allowModelData: "none" }, accept: ["allow"] },
  { name: "data-egress: PII/secret stops for a human", gate: "data-egress", input: { text: "email a@b.com key sk-ant-abcdefghijklmnopqrstuvwxyz1234567890", destination: "OpenAI" }, policy: { frameworks: ["GDPR"], allowModelData: "none" }, accept: ["require_human"] },
];

async function login() {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
  const { token } = await r.json();
  if (!token) throw new Error(`login failed (${r.status})`);
  return token;
}

async function runGate(token, gate, input, policy) {
  const r = await fetch(`${BASE}/api/gate/${gate}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ input, policy }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  const token = await login();
  let pass = 0, fail = 0;
  console.log(`dogfood battery -> ${BASE}\n`);
  for (const s of SCENARIOS) {
    const { status, body } = await runGate(token, s.gate, s.input, s.policy);
    const verdict = body.verdict;
    const ok = status === 200 && s.accept.includes(verdict);
    // transparency assertions: a deterministic gate must NOT have sent data to a model.
    const noModel = body.transparency?.modelInvoked === null;
    console.log(`${ok ? "PASS" : "FAIL"}  ${s.name}`);
    console.log(`      verdict=${verdict} (accept ${s.accept.join("|")})  modelInvoked=${body.transparency?.modelInvoked ?? "null"}  ledger#${body.recordedSeq ?? "-"}`);
    if (verdict === "deny" || verdict === "require_human") console.log(`      reason: ${body.reason}`);
    if (!ok || !noModel) { fail++; if (!noModel) console.log("      WARN: a deterministic gate reported a model was invoked"); }
    else pass++;
  }
  console.log(`\n${pass}/${SCENARIOS.length} scenarios matched.`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e.message || e); process.exit(1); });
