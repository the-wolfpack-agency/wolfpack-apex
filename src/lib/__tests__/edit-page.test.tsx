/**
 * Site edit page — extracted pure helpers.
 *
 * Follows the convention pinned in sites-detail-ui.test.tsx: Next.js 16's
 * `use(params: Promise)` suspends in jsdom and RTL's waitFor never gets
 * the scheduler tick that would resume it. Full-flow coverage lives in
 * the Playwright suite (tests/e2e/sites-edit-flow.spec.ts). This file
 * pins the error-mapping contract + dirty-computation contract so the
 * branches have unit-level protection.
 */

import { mapEditError, briefsDiffer } from "@/app/(dashboard)/sites/[id]/edit/page";
import type { Brief } from "@/components/sites/BriefForm";

const BASE_BRIEF: Brief = {
  client: "test3",
  product: { name: "Test" },
  pages: [{ route: "/", sections: [{ type: "hero", heading: "Hello" }] }],
};

describe("mapEditError — branches the UI renders in the banner", () => {
  it("renders a specific, field-naming message for patch_blocked", () => {
    const msg = mapEditError({
      error: "Patch touched protected fields",
      reason: "patch_blocked",
      blockedPaths: ["/client_slug", "/github_repo"],
    });
    expect(msg).toMatch(/refused/i);
    expect(msg).toMatch(/client_slug/);
    expect(msg).toMatch(/github_repo/);
  });

  it("renders a retryable message for ai_unavailable", () => {
    const msg = mapEditError({ error: "x", reason: "ai_unavailable" });
    expect(msg).toMatch(/unavailable/i);
    expect(msg).toMatch(/again/i);
  });

  it("falls back to the server's error string for unknown reasons", () => {
    const msg = mapEditError({ error: "Quota exceeded for project", reason: "quota" });
    expect(msg).toBe("Quota exceeded for project");
  });

  it("has a safe default when the server sends nothing useful", () => {
    const msg = mapEditError({});
    expect(msg).toBe("Edit failed.");
  });

  it("handles patch_blocked with empty blockedPaths without exploding", () => {
    const msg = mapEditError({ reason: "patch_blocked" });
    expect(msg).toMatch(/refused/i);
    // trailing ": ." — ok, no crash is the important part
  });
});

describe("briefsDiffer — governs the Publish button enable state", () => {
  it("returns false when both briefs are null", () => {
    expect(briefsDiffer(null, null)).toBe(false);
  });

  it("returns false when either side is null (nothing to compare yet)", () => {
    expect(briefsDiffer(BASE_BRIEF, null)).toBe(false);
    expect(briefsDiffer(null, BASE_BRIEF)).toBe(false);
  });

  it("returns false when draft is structurally identical to saved", () => {
    const clone = JSON.parse(JSON.stringify(BASE_BRIEF)) as Brief;
    expect(briefsDiffer(BASE_BRIEF, clone)).toBe(false);
  });

  it("returns true when the draft diverges on any field", () => {
    const modified: Brief = JSON.parse(JSON.stringify(BASE_BRIEF));
    (modified.pages[0].sections[0] as { heading?: string }).heading = "Season One";
    expect(briefsDiffer(BASE_BRIEF, modified)).toBe(true);
  });

  it("returns true for added sections", () => {
    const modified: Brief = JSON.parse(JSON.stringify(BASE_BRIEF));
    modified.pages[0].sections.push({ type: "text", body: "New section" });
    expect(briefsDiffer(BASE_BRIEF, modified)).toBe(true);
  });
});
