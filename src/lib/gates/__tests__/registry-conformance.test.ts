/**
 * registry-conformance.test.ts - the "gates can't regress" guardrail.
 *
 * Proves, for EVERY gate (current and future):
 *   1. every src/lib/gates/*-gate.ts is REGISTERED (add a gate file, forget to
 *      register it -> this fails, so it can never silently be unreachable);
 *   2. every registered gate has a valid, unique, URL-safe name (= its endpoint
 *      segment), a non-empty purpose, an entitlement, and an evaluate function;
 *   3. running any gate through runGate yields a CONTRACT-VALID result - a verdict
 *      in the four, a fully-populated transparency record, the framework stamped,
 *      and a well-formed audit payload.
 *
 * Together with each gate's own behavior test, this is the regression net: a
 * malformed or unregistered gate fails the build.
 */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { listGates, getGate } from "@/lib/gates/registry";
import { runGate } from "@/lib/gates/run-gate";
import type { GateVerdict } from "@/lib/gates/types";

const GATES_DIR = join(process.cwd(), "src/lib/gates");
const VERDICTS: GateVerdict[] = ["allow", "auto_fix", "require_human", "deny"];
const ctx = { workspaceId: "w1", actorId: "u1", policy: { frameworks: ["SOC2"], allowModelData: "none" as const } };

/** Gate name declared in each *-gate.ts source file. */
function gateFileNames(): { file: string; name: string }[] {
  return readdirSync(GATES_DIR)
    .filter((f) => f.endsWith("-gate.ts") && f !== "run-gate.ts")
    .map((file) => {
      const src = readFileSync(join(GATES_DIR, file), "utf8");
      const m = src.match(/\bname:\s*"([a-z0-9-]+)"/);
      return { file, name: m ? m[1] : "" };
    });
}

test("every *-gate.ts file declares a name that is REGISTERED (no unreachable gate)", () => {
  for (const { name } of gateFileNames()) {
    expect(name).not.toBe(""); // the file must declare a gate name
    expect(getGate(name)).toBeDefined(); // ...and it must be registered
    expect(getGate(name)!.name).toBe(name);
  }
});

test("registered gate names are valid (URL-safe), unique, and match listGates", () => {
  const gates = listGates();
  const names = gates.map((g) => g.name);
  expect(new Set(names).size).toBe(names.length); // unique
  for (const g of gates) {
    expect(g.name).toMatch(/^[a-z][a-z0-9-]*$/); // URL-safe endpoint segment
    expect(g.purpose.length).toBeGreaterThan(10); // a real, client-facing description
    expect(g.entitlement).toBeTruthy(); // every gate is entitlement-gated
  }
  // At least the gates we've built are present.
  for (const n of ["safe-review", "ci-autofix", "deploy-health", "preview-verify", "prod-promote", "data-egress", "dependency-review"]) {
    expect(names).toContain(n);
  }
});

describe("every registered gate returns a contract-valid result through runGate", () => {
  // Hermetic: no gate should reach the network in this shape test. The health
  // gates then see an unreachable URL and return a deterministic verdict.
  beforeAll(() => { jest.spyOn(global, "fetch").mockRejectedValue(new Error("network blocked in conformance test")); });
  afterAll(() => jest.restoreAllMocks());

  // A benign input per gate. IO-heavy gates get a minimal input; they may reach an
  // early deterministic branch, but the RESULT SHAPE is what this asserts.
  const inputFor: Record<string, unknown> = {
    "safe-review": { diff: "diff --git a/x b/x\n+ok" },
    "ci-autofix": { repo: "o/r", branch: "factory/x", base: "main" },
    "deploy-health": { url: "https://example.invalid.wolfpack" },
    "preview-verify": { url: "https://example.invalid.wolfpack" },
    "prod-promote": { previewUrl: "https://p" },
    "data-egress": { text: "hello" },
    "dependency-review": { diff: "diff --git a/x b/x\n+ok" },
    "prompt-injection": { text: "hello there" },
  };

  for (const { name } of listGates()) {
    it(`${name}: result conforms to the gate contract`, async () => {
      const def = getGate(name)!;
      const r = await runGate(def, inputFor[name] ?? {}, ctx);
      expect(VERDICTS).toContain(r.verdict);
      expect(typeof r.reason).toBe("string");
      expect(Array.isArray(r.findings)).toBe(true);
      // transparency is always present and populated
      expect(Array.isArray(r.transparency.checksRun)).toBe(true);
      expect(typeof r.transparency.dataSeen).toBe("string");
      expect(r.transparency.frameworksApplied).toEqual(["SOC2"]); // stamped by runGate
      // audit payload is uniform + carries the caller
      expect(r.audit).toMatchObject({ gate: name, workspaceId: "w1", actorId: "u1", verdict: r.verdict });
    });
  }
});
