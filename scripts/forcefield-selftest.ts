/**
 * Forcefield readiness self-test - a synthetic adversary, run on demand.
 *
 * "Are we ready when the bad agents come?" answered in seconds, without waiting
 * for a real attacker. Fetches the LIVE ruleset the deployed edge fetches, then
 * fires KNOWN-BAD input at every defense and confirms each one catches it - AND
 * that known-GOOD input is NOT caught (a false positive is a failure too). Exits
 * non-zero if any defense is silent, so it can gate CI or run from a cron.
 *
 *   npm run selftest:forcefield
 *   SELFTEST_RULESET_URL=<url> npm run selftest:forcefield   # against another site
 */
import { classifyHosting, datacenterPrefixesFrom } from "@/lib/forcefield-web/hosting";
import { detectPayload } from "@/lib/forcefield-web/enforce";
import { classifyWebRequest } from "@/lib/forcefield-web/classify";
import { classifyClient } from "@/lib/forcefield-web/fingerprint";
import { matchProbePath } from "@/lib/agent-probe-signatures";

const RULESET_URL = process.env.SELFTEST_RULESET_URL || "https://wolfpack-instinct.vercel.app/api/forcefield/ruleset";

let fails = 0;
function check(lens: string, name: string, pass: boolean): void {
  if (!pass) fails++;
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${lens.padEnd(9)} ${name}`);
}

(async () => {
  const res = await fetch(RULESET_URL);
  if (!res.ok) { console.error("could not fetch ruleset:", res.status); process.exit(2); }
  const { ruleset } = await res.json();
  const dc = datacenterPrefixesFrom(ruleset.datacenterPrefixes);
  console.log(`Forcefield readiness self-test vs LIVE ruleset:`);
  console.log(`  ${(ruleset.datacenterPrefixes || []).length} datacenter prefixes | ${ruleset.trapPaths.length} traps | ${ruleset.sensitivePaths.length} sensitive paths | ${ruleset.toolSignatures.length} tool signatures\n`);

  // 1. Hosting - datacenter vs residential (the one that started this).
  check("hosting", "real AWS IP -> datacenter", classifyHosting("52.94.236.248", dc) === "datacenter");
  check("hosting", "real GCP IP -> datacenter", classifyHosting("34.64.4.1", dc) === "datacenter");
  check("hosting", "residential IP -> residential (no false positive)", classifyHosting("24.60.1.1", dc) === "residential");

  // 2. Payload lens - known injection attempts must be caught.
  const payloads: [string, string][] = [
    ["/x?q=%27%20OR%201%3D1--", "SQL injection"],
    ["/x?q=<script>alert(1)</script>", "cross-site scripting"],
    ["/x?f=../../../../etc/passwd", "path traversal"],
    ["/x?url=http://169.254.169.254/latest/meta-data/", "SSRF (cloud metadata)"],
    ["/x?next=//evil.example.com", "open redirect"],
  ];
  for (const [p, name] of payloads) check("payload", `${name} caught`, detectPayload("https://s" + p) !== null);
  check("payload", "benign query NOT flagged (no false positive)", detectPayload("https://s/search?q=hello+world") === null);

  // 3. Recon lens - known sensitive-file probes must be recognized.
  for (const path of ["/.env", "/.git/config", "/wp-login.php", "/.aws/credentials"]) check("probe", `${path} recognized as recon`, matchProbePath(path) !== null);
  check("probe", "/pricing NOT a probe (no false positive)", matchProbePath("/pricing") === null);

  // 4. Honeytoken lens - a request to a trap path is a scanner.
  const cfg = { trapPaths: ruleset.trapPaths, knownAgents: ruleset.knownAgents };
  check("honeytoken", "trap path -> trapped", classifyWebRequest({ path: ruleset.trapPaths[0], method: "GET", userAgent: "any" }, cfg).class === "trapped");
  check("honeytoken", "normal path NOT trapped (no false positive)", classifyWebRequest({ path: "/pricing", method: "GET", userAgent: "Mozilla/5.0" }, cfg).class !== "trapped");

  // 5. Client lens - named attack tools are scanners; a browser is not.
  check("client", "sqlmap UA -> scanner", classifyClient("sqlmap/1.5.2", ["user-agent"], ruleset.toolSignatures).clientType === "scanner");
  check("client", "Nikto UA -> scanner", classifyClient("Nikto/2.1.6", ["user-agent"], ruleset.toolSignatures).clientType === "scanner");
  check("client", "real browser NOT a scanner (no false positive)", classifyClient("Mozilla/5.0 (Macintosh) Chrome/120", ["user-agent", "accept", "accept-language", "sec-fetch-dest"], ruleset.toolSignatures).clientType !== "scanner");

  console.log("\n" + (fails === 0
    ? "READY: every defense fired on known-bad input and held on known-good."
    : `${fails} CHECK(S) FAILED - a defense is not firing. Investigate before it matters.`));
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
