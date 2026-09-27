/**
 * categorizeChecks: raw GitHub check runs -> product-agnostic checkpoints. Pure.
 * Labels never name the tool (Build & deploy, not Vercel; Security, not CodeQL).
 */
import { categorizeChecks } from "@/lib/ai-code/ci-status";
import type { CheckRun } from "@/lib/github-client";

const chk = (name: string, conclusion: string | null, status = "completed"): CheckRun => ({ name, status, conclusion, output: null });

test("maps tool-named checks into friendly checkpoints", () => {
  const d = categorizeChecks([
    chk("unit (1/4)", "success"),
    chk("lint-types", "success"),
    chk("Static Security Scan", "success"),
    chk("SQL against a real Postgres", "success"),
    chk("Vercel", "success"),
    chk("e2e", "success"),
  ]);
  const byKey = Object.fromEntries(d.categories.map((c) => [c.key, c]));
  expect(byKey.unit.label).toBe("Unit tests");
  expect(byKey.unit.status).toBe("pass");
  expect(byKey["build-deploy"].status).toBe("pass"); // Vercel -> Build & deploy
  expect(byKey.security.status).toBe("pass");         // CodeQL/scan -> Security
  expect(byKey["data-db"].status).toBe("pass");       // Postgres -> Data & privacy
  // no label leaks a product name
  expect(d.categories.map((c) => c.label).join(" ")).not.toMatch(/vercel|codeql|jest|postgres/i);
});

test("status rollup is worst-wins and overall reflects it", () => {
  const failing = categorizeChecks([chk("unit", "success"), chk("e2e reality-check", "failure")]);
  expect(failing.categories.find((c) => c.key === "ui-e2e")!.status).toBe("fail");
  expect(failing.overall).toBe("fail");

  const running = categorizeChecks([chk("unit", "success"), chk("lint", null, "in_progress")]);
  expect(running.overall).toBe("pending");

  const green = categorizeChecks([chk("unit", "success")]);
  expect(green.overall).toBe("pass");

  expect(categorizeChecks([]).overall).toBe("absent");
});

test("a check that matches nothing lands in Other checks, never dropped", () => {
  const d = categorizeChecks([chk("something-bespoke", "success")]);
  expect(d.categories.find((c) => c.key === "other")!.passed).toBe(1);
});
