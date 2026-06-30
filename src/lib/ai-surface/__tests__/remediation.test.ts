/**
 * Unit tests for the deterministic remediation generator.
 *
 * Asserts: every AiSurfaceKind yields non-empty guidance (steps + a gate
 * snippet); the output is deterministic (same input -> identical output, no
 * LLM); priority derives from risk; and remediateAll preserves input order.
 */

import { remediationFor, remediateAll } from "../remediation";
import type { AiSurfaceKind, AiSurfaceRisk } from "../types";

const ALL_KINDS: AiSurfaceKind[] = [
  "ai_sdk",
  "provider_endpoint",
  "api_key",
  "ai_route",
  "mcp_server",
];

test("every AiSurfaceKind yields non-empty, gate-routed guidance", () => {
  for (const kind of ALL_KINDS) {
    const r = remediationFor({ kind, provider: "openai", risk: "medium" });
    expect(r.kind).toBe(kind);
    expect(r.provider).toBe("openai");
    expect(r.summary.length).toBeGreaterThan(0);
    expect(r.steps.length).toBeGreaterThan(0);
    // Every fix routes the surface through the OGIAM gate.
    expect(r.snippet).toContain("/api/gate/authorize");
  }
});

test("is deterministic: identical input -> identical output (no LLM)", () => {
  const a = remediationFor({ kind: "api_key", provider: "anthropic", risk: "critical" });
  const b = remediationFor({ kind: "api_key", provider: "anthropic", risk: "critical" });
  expect(a).toEqual(b);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

test("priority derives deterministically from risk", () => {
  const cases: Array<[AiSurfaceRisk, string]> = [
    ["critical", "now"],
    ["high", "soon"],
    ["medium", "later"],
    ["low", "later"],
  ];
  for (const [risk, expected] of cases) {
    expect(remediationFor({ kind: "ai_sdk", provider: "openai", risk }).priority).toBe(expected);
  }
});

test("api_key guidance leads with revocation (highest-risk surface)", () => {
  const r = remediationFor({ kind: "api_key", provider: "openai", risk: "critical" });
  expect(r.steps[0].toLowerCase()).toContain("revoke");
});

test("remediateAll maps each surface in input order", () => {
  const surfaces = [
    { kind: "ai_sdk" as const, provider: "openai", risk: "medium" as const },
    { kind: "api_key" as const, provider: "anthropic", risk: "critical" as const },
  ];
  const out = remediateAll(surfaces);
  expect(out.map((r) => r.kind)).toEqual(["ai_sdk", "api_key"]);
  expect(out.map((r) => r.provider)).toEqual(["openai", "anthropic"]);
});
