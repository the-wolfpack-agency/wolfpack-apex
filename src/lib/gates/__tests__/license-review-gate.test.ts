/**
 * The license-review gate: a restrictive/copyleft license introduced -> require_human;
 * a permissive/no license signal -> allow. Deterministic.
 */
import { licenseReviewGate } from "@/lib/gates/license-review-gate";
import { runGate } from "@/lib/gates/run-gate";

const ctx = { workspaceId: "w1", actorId: "u1", policy: { frameworks: ["SOC2"], allowModelData: "none" as const } };
const diffAdd = (file: string, line: string) => `diff --git a/${file} b/${file}\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+${line}\n`;

it.each([
  ["SPDX GPL", "src/x.ts", "// SPDX-License-Identifier: GPL-3.0-or-later"],
  ["GPL header", "src/y.ts", " * This program is free software under the GNU General Public License"],
  ["SSPL", "src/z.ts", "Licensed under the Server Side Public License"],
  ["package license flip", "package.json", '  "license": "AGPL-3.0",'],
])("require_human: %s", async (_l, file, line) => {
  const r = await runGate(licenseReviewGate, { diff: diffAdd(file, line) }, ctx);
  expect(r.verdict).toBe("require_human");
  expect(r.output?.signals.length).toBeGreaterThan(0);
  expect(r.transparency.modelInvoked).toBeNull();
});

it("allow: a permissive license / ordinary code", async () => {
  const r = await runGate(licenseReviewGate, { diff: diffAdd("package.json", '  "license": "MIT",') }, ctx);
  expect(r.verdict).toBe("allow");
  expect(r.output?.signals).toEqual([]);
});
