/**
 * Forcefield live self-test: the read-only auth-boundary / info-disclosure /
 * input-validation probe we run OURSELVES against the deployed control plane,
 * before (and independent of) any paid third-party engagement.
 *
 *   npm run forcefield:selftest                 # probe production
 *   FORCEFIELD_SELFTEST_BASE=https://... npm run forcefield:selftest
 *
 * Deterministic and harmless: a handful of GETs + one empty POST, checking status
 * codes and that a refused request leaks no body. No scope token needed (it only
 * verifies that our own endpoints gate correctly), so it is safe to run in CI or
 * on demand. Exits non-zero if any boundary is wrong, so it can gate a release.
 *
 * This is the self-run equivalent of the auth-bypass / IDOR / info-disclosure
 * classes a pen tester checks first. The DEEP active engagement (the scoped
 * harness in src/lib/platform-scan/pentest) still issues a scope and records
 * findings; this is the fast, always-safe boundary check.
 */
const BASE = (process.env.FORCEFIELD_SELFTEST_BASE || "https://wolfpack-instinct.vercel.app").replace(/\/+$/, "");

interface Check { name: string; method: "GET" | "POST"; path: string; expect: number[]; body?: string; noLeak?: boolean }

const CHECKS: Check[] = [
  // Public surfaces must serve.
  { name: "public-stats serves", method: "GET", path: "/api/forcefield/public-stats", expect: [200] },
  { name: "status serves", method: "GET", path: "/api/forcefield/status", expect: [200] },
  { name: "signup page serves", method: "GET", path: "/forcefield/signup", expect: [200] },
  { name: "dashboard page serves", method: "GET", path: "/forcefield/dashboard", expect: [200] },
  // Token-gated endpoints must refuse an unauthenticated / bogus-token caller and leak no body.
  { name: "my-stats refuses no token", method: "GET", path: "/api/forcefield/my-stats", expect: [401], noLeak: true },
  { name: "my-setup refuses no token", method: "GET", path: "/api/forcefield/my-setup", expect: [401], noLeak: true },
  // Capability-gated admin endpoints must refuse an unauthenticated caller.
  { name: "admin tenants gated", method: "GET", path: "/api/admin/forcefield/tenants", expect: [401, 403] },
  { name: "admin signups gated", method: "GET", path: "/api/admin/forcefield/signups", expect: [401, 403] },
  { name: "admin docs gated", method: "GET", path: "/api/admin/forcefield/docs", expect: [401, 403] },
  // Public signup must reject an empty body before any write.
  { name: "signup rejects empty body", method: "POST", path: "/api/forcefield/signup", expect: [400], body: "{}" },
];

/** The fields a refused response must never contain (would indicate a data leak). */
const LEAK_MARKERS = ["forcefield_tenant", "token_sha256", "siteLabel", "agentsDetected"];

async function run(): Promise<number> {
  console.log(`Forcefield self-test -> ${BASE}`);
  let failures = 0;
  for (const c of CHECKS) {
    let code = 0;
    let body = "";
    try {
      const res = await fetch(`${BASE}${c.path}`, {
        method: c.method,
        headers: c.method === "POST" ? { "content-type": "application/json" } : undefined,
        body: c.body,
      });
      code = res.status;
      if (c.noLeak) body = (await res.text()).slice(0, 2000);
    } catch (err) {
      console.log(`  FAIL  ${c.name}: request error ${(err as Error).message}`);
      failures++;
      continue;
    }
    const codeOk = c.expect.includes(code);
    const leakOk = !c.noLeak || !LEAK_MARKERS.some((m) => body.includes(m));
    if (codeOk && leakOk) {
      console.log(`  PASS  ${c.name} (${code})`);
    } else {
      failures++;
      console.log(`  FAIL  ${c.name}: got ${code}, expected ${c.expect.join("/")}${!leakOk ? " + response leaked tenant data" : ""}`);
    }
  }
  console.log(failures === 0 ? "\nAll Forcefield boundary checks passed." : `\n${failures} boundary check(s) FAILED.`);
  return failures === 0 ? 0 : 1;
}

run().then((code) => process.exit(code));
