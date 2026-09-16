/**
 * Enforces: no credential and no single-use link is ever written to a log.
 *
 * A password-reset / verify link is a bearer credential for one account, and a
 * token or secret in a log is a leaked secret — logs are retained, shipped to
 * aggregators, and broadly readable. On 2026-09 a raw password-reset URL was
 * written to server logs in a sibling repo; nothing in any gate caught it
 * because "no secrets in logs" lived only as prose, never as an enforced check.
 * This test is that check: it fails the build if a credential- or reset-link-
 * named value (or a provider-signature secret) reaches console.* / a logger.
 *
 * It reuses the SAME deterministic detector the Secure Agent pipeline runs on a
 * produced diff (secretInLogs in platform-scan/static/detectors.ts), so the rule
 * the agent is judged by and the rule this repo is held to are one rule.
 */
import fs from "fs";
import path from "path";
import { secretInLogs } from "@/lib/platform-scan/static/detectors";

const EXCEPTIONS = [
  "node_modules/",
  ".next/",
  "__tests__/", // fixtures deliberately contain sample offending log lines
  // The detector documents the pattern it catches in its own docstring
  // (``console.log(`link ${resetUrl}`)``), which is not executable code.
  "src/lib/platform-scan/static/detectors.ts",
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (EXCEPTIONS.some((e) => full.includes(e))) continue;
    if (/\.(test|spec)\.(ts|tsx)$/.test(entry.name)) continue;
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("no secret or single-use link written to a log", () => {
  it("forbids a credential / reset-link value reaching console.* or a logger", () => {
    const root = path.resolve(__dirname, "..");
    const files = walk(root);
    const offenders: Array<{ file: string; line: number; title: string; snippet: string }> = [];

    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      for (const f of secretInLogs({ path: path.relative(root, file), content })) {
        offenders.push({
          file: path.relative(root, file),
          line: Number(f.evidence.line),
          title: f.title,
          snippet: String(f.evidence.snippet),
        });
      }
    }

    if (offenders.length > 0) {
      const list = offenders
        .map((o) => `  src/${o.file}:${o.line} — ${o.title}\n      ${o.snippet}`)
        .join("\n");
      throw new Error(
        `Credential or single-use link written to a log detected. Never log a secret, ` +
          `token, or reset/verify link; log a non-sensitive id or a redacted form.\n${list}\n\n` +
          `See secretInLogs in src/lib/platform-scan/static/detectors.ts.`,
      );
    }
  });
});
