import { PROMPT_CHIPS, chipById } from "@/components/ai-code/factory-chat/chips";

describe("prompt chips", () => {
  it("every chip has a unique id, a seed prompt, and a task type", () => {
    const ids = new Set<string>();
    for (const c of PROMPT_CHIPS) {
      expect(c.prompt.length).toBeGreaterThan(0);
      expect(c.taskType).toBeTruthy();
      expect(ids.has(c.id)).toBe(false);
      ids.add(c.id);
    }
    expect(PROMPT_CHIPS.length).toBeGreaterThanOrEqual(5);
  });
  it("chipById resolves a known chip and returns undefined otherwise", () => {
    expect(chipById("migration")?.taskType).toBe("migration");
    expect(chipById("nope")).toBeUndefined();
  });
});
