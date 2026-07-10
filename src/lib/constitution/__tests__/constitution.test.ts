import type { AICompleteRequest } from "@/lib/ai/types";
import {
  CONSTITUTION_VERSION,
  applyConstitutionToRequest,
  getConstitution,
  renderConstitutionPreamble,
} from "@/lib/constitution";

function baseReq(overrides: Partial<AICompleteRequest> = {}): AICompleteRequest {
  return {
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 100,
    model_tier: "standard",
    ...overrides,
  };
}

describe("OGIAM Agent Constitution module", () => {
  it("exposes a version and the constitution text", () => {
    expect(CONSTITUTION_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const text = getConstitution();
    expect(text).toContain("OGIAM Agent Constitution");
    // A representative rule must be present so we know the real doc is bundled.
    expect(text.toLowerCase()).toContain("em dash");
  });

  it("renders a preamble that carries the version and the rules", () => {
    const p = renderConstitutionPreamble();
    expect(p).toContain(`OGIAM Agent Constitution v${CONSTITUTION_VERSION}`);
    expect(p).toContain("governance, not suggestions");
    expect(p).toContain(getConstitution());
  });

  it("is a no-op when the request did not opt in", () => {
    const req = baseReq({ system: "You are a helper." });
    const out = applyConstitutionToRequest(req);
    expect(out).toBe(req); // same reference, untouched
    expect(out.system).toBe("You are a helper.");
  });

  it("prepends the constitution when the request opts in, preserving the caller's system", () => {
    const req = baseReq({ system: "You are a helper.", apply_constitution: true });
    const out = applyConstitutionToRequest(req);
    expect(out).not.toBe(req); // new object, no mutation
    expect(req.system).toBe("You are a helper."); // original untouched
    expect(out.system!.startsWith("# OGIAM Agent Constitution")).toBe(true);
    expect(out.system).toContain("You are a helper.");
    // constitution leads, caller's prompt follows
    expect(out.system!.indexOf("OGIAM Agent Constitution")).toBeLessThan(
      out.system!.indexOf("You are a helper."),
    );
  });

  it("uses the constitution alone when the caller supplied no system prompt", () => {
    const req = baseReq({ apply_constitution: true });
    const out = applyConstitutionToRequest(req);
    expect(out.system).toBe(renderConstitutionPreamble());
  });
});
