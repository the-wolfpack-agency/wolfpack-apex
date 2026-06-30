/**
 * Tests for the self-scan glue. The detection/rollup itself is covered by the
 * ai-surface suite; here we prove the self-scan-specific logic: the file filter
 * (extensions + ignored dirs) and that summarizeSelfScan reuses the production
 * detector + summarize + remediation path to produce correct counts, the
 * ungoverned set, and a remediation per ungoverned surface.
 */

import { shouldScanFile, summarizeSelfScan, SCAN_EXTENSIONS, IGNORE_DIRS } from "../self-scan";
import type { SourceFile } from "../detect";

describe("shouldScanFile", () => {
  test("accepts code + config extensions outside ignored dirs", () => {
    expect(shouldScanFile("src/lib/ai/anthropic.ts")).toBe(true);
    expect(shouldScanFile("config/.env.example")).toBe(true);
    expect(shouldScanFile("vercel.json")).toBe(true);
  });
  test("rejects ignored dirs and non-scannable extensions", () => {
    expect(shouldScanFile("node_modules/openai/index.js")).toBe(false);
    expect(shouldScanFile(".next/server/chunk.js")).toBe(false);
    expect(shouldScanFile("public/logo.png")).toBe(false);
    expect(shouldScanFile("src/lib/.git/config")).toBe(false);
  });
  test("the ignore + extension sets are non-empty (config did not get blanked)", () => {
    expect(IGNORE_DIRS.has("node_modules")).toBe(true);
    expect(SCAN_EXTENSIONS.has(".ts")).toBe(true);
  });
});

describe("summarizeSelfScan", () => {
  // SDK import + provider endpoint only (no secret literal: api_key detection is
  // covered by detect.test.ts, and we avoid putting a key-shaped string in a new file).
  const files: SourceFile[] = [
    { path: "src/a.ts", content: `import Anthropic from "@anthropic-ai/sdk";` },
    { path: "src/b.ts", content: `const url = "https://api.openai.com/v1/chat";` },
    { path: "src/clean.ts", content: `export const add = (a: number, b: number) => a + b;` },
  ];

  test("counts surfaces by kind/provider and reports the ungoverned gap", () => {
    const r = summarizeSelfScan(files);
    expect(r.filesScanned).toBe(3);
    expect(r.summary.total).toBeGreaterThanOrEqual(2); // sdk + endpoint
    expect(r.summary.byKind["ai_sdk"]).toBeGreaterThanOrEqual(1);
    expect(r.summary.byKind["provider_endpoint"]).toBeGreaterThanOrEqual(1);
    expect(r.summary.byProvider["anthropic"]).toBeGreaterThanOrEqual(1);
    expect(r.summary.byProvider["openai"]).toBeGreaterThanOrEqual(1);
  });

  test("a remediation is produced for every ungoverned surface", () => {
    const r = summarizeSelfScan(files);
    const ungoverned = r.surfaces.filter((s) => !s.governed);
    expect(r.remediations).toHaveLength(ungoverned.length);
    expect(r.remediations.every((rem) => rem.summary.length > 0 && rem.steps.length > 0)).toBe(true);
  });

  test("a file with no AI touchpoint contributes nothing", () => {
    const r = summarizeSelfScan([{ path: "src/clean.ts", content: "export const x = 1;" }]);
    expect(r.summary.total).toBe(0);
    expect(r.remediations).toEqual([]);
  });
});
