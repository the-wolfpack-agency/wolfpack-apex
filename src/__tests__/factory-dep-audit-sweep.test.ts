/**
 * Shape guard for the proactive dependency-audit sweep (offline). A new advisory
 * must be caught BEFORE it lands on a human's PR, remediated deterministically, and
 * surfaced either way. This pins the control's intent so it cannot silently rot.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const TEMPLATE = path.join(ROOT, "templates/factory-dep-audit-sweep.yml");
const INSTALLED = path.join(ROOT, ".github/workflows/factory-dep-audit-sweep.yml");

describe("factory-dep-audit-sweep", () => {
  const installed = fs.readFileSync(INSTALLED, "utf-8");

  it("is installed on apex itself (dogfooded) and a reusable template exists", () => {
    expect(fs.existsSync(INSTALLED)).toBe(true);
    expect(fs.existsSync(TEMPLATE)).toBe(true);
  });
  it("the installed copy SHA-pins its actions (apex supply-chain guardrail)", () => {
    for (const m of installed.matchAll(/uses:\s*actions\/[\w-]+@(\S+)/g)) {
      expect(m[1]).toMatch(/^[0-9a-f]{40}$/);
    }
  });
  it("runs on a schedule (proactive, before a human PR trips it)", () => {
    expect(installed).toMatch(/schedule:/);
    expect(installed).toMatch(/cron:/);
  });
  it("audits only production deps for high/critical", () => {
    expect(installed).toMatch(/npm audit --omit=dev/);
  });
  it("remediates with a TARGETED lockfile-only fix (never a blanket fix)", () => {
    expect(installed).toMatch(/npm audit fix --package-lock-only --omit=dev/);
  });
  it("proves the fix before opening a PR (audit clean + tests pass)", () => {
    expect(installed).toMatch(/npm run test --if-present/);
  });
  it("opens a factory/* PR (flows through the normal gate + human approval, never auto-merges)", () => {
    expect(installed).toMatch(/factory\/dep-audit-sweep-/);
    expect(installed).toMatch(/gh pr create/);
  });
  it("fails loudly when a high/critical has NO fix (surfaces to a human)", () => {
    expect(installed).toMatch(/NO available fix/i);
    expect(installed).toMatch(/exit 1/);
  });
});
