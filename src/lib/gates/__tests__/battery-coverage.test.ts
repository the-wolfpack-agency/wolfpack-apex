/**
 * battery-coverage.test.ts - enforces that EVERY registered gate is verified by
 * the live dogfood battery (or is explicitly exempt with a reason). A gate is part
 * of the product, so it must be provably exercised end-to-end - this fails the
 * build if a new gate is registered without a battery scenario, mirroring the
 * repo's capability/provider-coverage guardrails.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { listGates } from "@/lib/gates/registry";

/** Gates that cannot run in the FAST battery (they need a live red PR + multiple
 *  CI cycles). Each is verified another way; the reason is recorded here. */
const BATTERY_EXEMPT: Record<string, string> = {
  "pre-pr-validate": "Needs a real repo + a pushed validation branch + a live factory-validate run to exercise. Verified by pre-pr-validate-gate.test.ts (every verdict path) + the pre-pr-validation module test, not the fast battery.",
  "ci-autofix": "Needs a live red PR + multiple CI cycles to reach auto_fix. Verified by ci-autofix-gate.test.ts (every verdict path) + live scripts/dogfood-ci-fix.mjs runs, not the fast battery.",
};

test("every registered gate has a fast battery scenario, or an exemption with a reason", () => {
  const battery = readFileSync(join(process.cwd(), "scripts/dogfood-battery.mjs"), "utf8");
  const missing: string[] = [];
  for (const g of listGates()) {
    if (BATTERY_EXEMPT[g.name]) continue;
    if (!battery.includes(`gate: "${g.name}"`)) missing.push(g.name);
  }
  expect(missing).toEqual([]); // add a scenario to scripts/dogfood-battery.mjs, or exempt with a reason
});

test("no stale exemptions (every exempt gate is still registered)", () => {
  const names = new Set(listGates().map((g) => g.name));
  for (const n of Object.keys(BATTERY_EXEMPT)) expect(names.has(n)).toBe(true);
});
