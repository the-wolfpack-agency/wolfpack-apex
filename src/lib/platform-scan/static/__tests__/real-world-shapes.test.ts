/**
 * Real-world regression guard for the static detectors.
 *
 * These fixtures are the EXACT code shapes the detectors caught (and correctly
 * ignored) when validated against the live wolfpack-auto admin source — 24 real
 * findings across 9 pages. Encoding them here makes that validation permanent +
 * CI-enforced without depending on an external checkout, and pins the subtle
 * precision boundaries (a try/catch that only catches network throws is NOT an
 * ok-check; an `if (res.ok)` guard IS) so a future detector refactor cannot
 * regress on real customer code.
 */
import { runDetectors } from "@/lib/platform-scan/static/detectors";

const cat = (fs: ReturnType<typeof runDetectors>, c: string) => fs.filter((f) => f.category === c);

it("fires silentFetch on the real 'await fetch -> json -> ?? []' shape guarded only by try/catch (customers page)", () => {
  // try/catch catches network throws, but a 401/500 returns a Response, json()
  // parses the error body, and `?? []` renders an empty grid: the silent blank.
  const content = `"use client";
function Customers() {
  const load = async () => {
    try {
      const res = await fetch(\`/api/admin/customers\${qs}\`);
      const data = await res.json();
      setCustomers(data.customers ?? []);
    } catch {
      setError("Failed to load customers.");
    }
  };
}`;
  const findings = runDetectors({ path: "src/app/admin/customers/page.tsx", content });
  expect(cat(findings, "bug")).toHaveLength(1);
  expect(findings.find((f) => f.category === "bug")).toMatchObject({ severity: "high", title: expect.stringMatching(/ok\/status/) });
  // The same line is also a raw authed fetch from a client component.
  expect(cat(findings, "security").some((f) => /raw fetch/i.test(f.title))).toBe(true);
});

it("does NOT fire silentFetch when the real code guards with `if (res.ok)` (leads page)", () => {
  const content = `"use client";
async function load() {
  const res = await fetch(\`/api/admin/leads?\${params}\`);
  if (res.ok) {
    const data = await res.json();
    setLeads(data.leads ?? []);
  }
}`;
  const findings = runDetectors({ path: "src/app/admin/leads/page.tsx", content });
  expect(cat(findings, "bug")).toHaveLength(0); // guarded -> true negative
  expect(cat(findings, "security").length).toBeGreaterThan(0); // raw /api fetch still flagged
});

it("fires hardcodedTenantId on the real `process.env.DEALER_ID ?? <uuid>` default (inventory/settings)", () => {
  const content = `const DEALER_ID = process.env.DEALER_ID ?? "00000000-0000-4000-a000-000000000001";`;
  const findings = runDetectors({ path: "src/app/admin/inventory/page.tsx", content });
  expect(findings.find((f) => f.category === "security")).toMatchObject({
    title: expect.stringMatching(/DEALER_ID/),
  });
});

it("stays silent on clean code (fetchWithRefresh + res.ok guard, no hardcoded tenant)", () => {
  const content = `"use client";
import { fetchWithRefresh } from "@/lib/client-auth";
async function load() {
  const res = await fetchWithRefresh("/api/admin/customers");
  if (!res.ok) { setError("unavailable"); return; }
  const data = await res.json();
  setCustomers(data.customers ?? []);
}`;
  expect(runDetectors({ path: "src/app/admin/customers/page.tsx", content })).toEqual([]);
});
