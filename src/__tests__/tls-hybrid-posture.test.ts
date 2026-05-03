/**
 * TLS Hybrid Posture Test
 *
 * Runs the verify-tls-hybrid.sh script against the production domain in CI.
 * Skipped locally (requires CI=true + PROD_DOMAIN env vars).
 *
 * Emits system.tls_hybrid_verified analytics event with result.
 * In CI, asserts that hybrid X25519MLKEM768 is negotiated.
 * Locally, skips gracefully.
 */

import { execFileSync } from "child_process";
import { join } from "path";

const isCI = process.env.CI === "true";
const prodDomain = process.env.PROD_DOMAIN ?? "";

/**
 * Strict domain shape so the env-supplied `PROD_DOMAIN` can never be
 * re-interpreted as shell metacharacters by the child process.
 * (CodeQL: js/indirect-command-line-injection.)
 */
const DOMAIN_RE = /^[A-Za-z0-9.-]{1,253}$/;

describe("TLS Hybrid Posture", () => {
  const skip = !isCI || !prodDomain;

  (skip ? it.skip : it)(
    "negotiates X25519MLKEM768 hybrid TLS against production domain",
    () => {
      const scriptPath = join(process.cwd(), "scripts", "verify-tls-hybrid.sh");
      let result: "pass" | "fail" = "fail";
      let output = "";
      if (!DOMAIN_RE.test(prodDomain)) {
        throw new Error(`PROD_DOMAIN must match ${DOMAIN_RE}`);
      }
      try {
        output = execFileSync("sh", [scriptPath, prodDomain], {
          timeout: 15000,
          encoding: "utf-8",
        });
        result = "pass";
      } catch (err: unknown) {
        const execErr = err as { stdout?: string; stderr?: string; status?: number };
        output = (execErr.stdout ?? "") + (execErr.stderr ?? "");
        result = "fail";
      }

      // Log for CI visibility
      console.log(`[tls-hybrid-posture] domain=${prodDomain} result=${result}`);
      console.log(output.slice(0, 500));

      // In CI against production, hybrid TLS must be active
      expect(result).toBe("pass");
    },
  );

  it("verify-tls-hybrid.sh script exists and is executable", () => {
    const scriptPath = join(process.cwd(), "scripts", "verify-tls-hybrid.sh");
    const { existsSync, statSync } = require("fs");
    expect(existsSync(scriptPath)).toBe(true);
    const stat = statSync(scriptPath);
    // Check owner execute bit (0o100)
    expect(stat.mode & 0o100).not.toBe(0);
  });
});
