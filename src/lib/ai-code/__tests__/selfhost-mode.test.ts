/**
 * Graduated self-host mode: our own repos roll out off -> comment -> enforce, and
 * a missing/typo'd env is fail-safe "off" (never acts on our repo by accident).
 */
import { isOurRepo, selfHostMode } from "@/lib/ai-code/selfhost-mode";

describe("isOurRepo", () => {
  it("recognizes apex (case-insensitive), not a client repo", () => {
    expect(isOurRepo("the-wolfpack-agency/wolfpack-apex")).toBe(true);
    expect(isOurRepo("The-Wolfpack-Agency/Wolfpack-Apex")).toBe(true);
    expect(isOurRepo("acme/app")).toBe(false);
  });
});

describe("selfHostMode", () => {
  it("defaults to off (fail-safe) for missing/unknown values", () => {
    expect(selfHostMode({})).toBe("off");
    expect(selfHostMode({ SELFHOST_GATE_MODE: "" })).toBe("off");
    expect(selfHostMode({ SELFHOST_GATE_MODE: "banana" })).toBe("off");
  });
  it("reads comment / enforce", () => {
    expect(selfHostMode({ SELFHOST_GATE_MODE: "comment" })).toBe("comment");
    expect(selfHostMode({ SELFHOST_GATE_MODE: " ENFORCE " })).toBe("enforce");
  });
});
