/** @jest-environment node */
/**
 * The local gate's type-check must not read tsconfig.tsbuildinfo. The incremental
 * cache skipped changed files and passed code that CI and Vercel's build then
 * failed (2026-10-07 and 2026-10-30), so scripts/verify.sh runs tsc with the
 * cache off. This keeps the flag from being dropped.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

it("scripts/verify.sh type-checks with --incremental false", () => {
  const sh = readFileSync(join(__dirname, "../../scripts/verify.sh"), "utf8");
  const line = sh.split("\n").find((l) => /run_stage "typecheck"/.test(l)) ?? "";
  expect(line).toMatch(/npx tsc --noEmit --incremental false/);
});
