/**
 * Brief-edit API — contract shape pins.
 *
 * The editor UI, the E2E suite, and the backend route hand data to each
 * other over these shapes. If any side drifts, integration breaks
 * silently. These tests pin the contract explicitly so a rename or
 * removed field fails the commit that caused it, not the user who
 * clicks Send tomorrow.
 *
 * Covered contracts:
 *   - POST /api/sites/[id]/brief-edit request body
 *   - POST response shape (success, ai_unavailable, patch_blocked)
 *   - PATCH /api/sites/[id]/brief-edit/[editId] request body + response
 *   - 5 new analytics event names land in ApexEventType (so trackEvent
 *     calls compile against the SSOT)
 *
 * Pattern mirrors brief-edit-migration.test.ts: parse source, assert
 * shape. No network, no DB.
 */

import { readFileSync } from "fs";
import { join } from "path";

const REPO = join(__dirname, "..", "..", "..");
const POST_ROUTE = join(REPO, "src", "app", "api", "sites", "[id]", "brief-edit", "route.ts");
const PATCH_ROUTE = join(REPO, "src", "app", "api", "sites", "[id]", "brief-edit", "[editId]", "route.ts");
const BRIEF_EDIT_LIB = join(REPO, "src", "lib", "brief-edit.ts");
const ANALYTICS = join(REPO, "src", "lib", "analytics.ts");

const postSource = readFileSync(POST_ROUTE, "utf8");
const patchSource = readFileSync(PATCH_ROUTE, "utf8");
const libSource = readFileSync(BRIEF_EDIT_LIB, "utf8");
const analyticsSource = readFileSync(ANALYTICS, "utf8");

describe("POST /api/sites/[id]/brief-edit contract", () => {
  it("requires an instruction field in the request body", () => {
    // Handler reads body.instruction
    expect(postSource).toMatch(/\binstruction\b/);
  });

  it("returns edit_id in the success body (UI needs it for accept/reject PATCH)", () => {
    expect(postSource).toMatch(/edit_id/);
  });

  it("returns patch, renderedBrief, and explanation in the success body", () => {
    // These three fields are what the editor UI consumes.
    expect(postSource).toMatch(/\bpatch\b/);
    expect(postSource).toMatch(/renderedBrief/);
    expect(postSource).toMatch(/explanation/);
  });

  it("maps patch_blocked to 422 with reason + blockedPaths (UI banner contract)", () => {
    expect(postSource).toMatch(/status:\s*422/);
    expect(postSource).toMatch(/patch_blocked/);
    expect(postSource).toMatch(/blockedPaths/);
  });

  it("maps ai_unavailable to 502 with a retryable reason code", () => {
    expect(postSource).toMatch(/status:\s*502/);
    expect(postSource).toMatch(/ai_unavailable/);
  });

  it("gates on JWT auth like the rest of the /api/sites family", () => {
    expect(postSource).toMatch(/getUserFromRequest/);
    expect(postSource).toMatch(/Unauthorized/);
  });
});

describe("PATCH /api/sites/[id]/brief-edit/[editId] contract", () => {
  it("accepts {accepted, rejectionReason?} in the request body", () => {
    expect(patchSource).toMatch(/\baccepted\b/);
    expect(patchSource).toMatch(/rejectionReason/);
  });

  it("returns {ok: true} on success (editor UI fire-and-forgets on this)", () => {
    expect(patchSource).toMatch(/ok:\s*true/);
  });

  it("gates on JWT auth", () => {
    expect(patchSource).toMatch(/getUserFromRequest/);
  });
});

describe("Brief-edit lib surface — shapes the route depends on", () => {
  it("exports BriefEditValidationError for the patch_blocked branch", () => {
    expect(libSource).toMatch(/export\s+class\s+BriefEditValidationError/);
  });

  it("exports BriefEditAIUnavailableError for the 502 branch", () => {
    expect(libSource).toMatch(/export\s+class\s+BriefEditAIUnavailableError/);
  });

  it("exports generateBriefEdit + recordBriefEditDecision", () => {
    expect(libSource).toMatch(/export\s+(?:async\s+)?function\s+generateBriefEdit/);
    expect(libSource).toMatch(/export\s+(?:async\s+)?function\s+recordBriefEditDecision/);
  });

  it("exports applyPatch + validatePatchPaths (pure helpers, unit-tested)", () => {
    expect(libSource).toMatch(/export\s+function\s+applyPatch/);
    expect(libSource).toMatch(/export\s+function\s+validatePatchPaths/);
  });
});

describe("Analytics event names land in ApexEventType (SSOT for events)", () => {
  const events = [
    "site.brief_edit_requested",
    "site.brief_edit_generated",
    "site.brief_edit_failed",
    "site.brief_edit_blocked",
    "site.brief_edit_decided",
  ];
  for (const ev of events) {
    it(`${ev} is a known ApexEventType`, () => {
      // Escape the dot for the regex.
      const re = new RegExp(`["']${ev.replace(".", "\\.")}["']`);
      expect(analyticsSource).toMatch(re);
    });
  }
});
