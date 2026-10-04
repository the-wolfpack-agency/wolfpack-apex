/** #9 flag: cross-repo memory is dark until explicitly flipped. */
import { crossRepoMemoryEnabled } from "@/lib/ai-code/reuse-scout-semantic";

describe("crossRepoMemoryEnabled", () => {
  it("is off by default and for falsey values", () => {
    expect(crossRepoMemoryEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(crossRepoMemoryEnabled({ AI_CODE_CROSS_REPO_MEMORY: "off" } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
  it("is on for on/true/1", () => {
    for (const v of ["on", "true", "1", "ON", " True "]) {
      expect(crossRepoMemoryEnabled({ AI_CODE_CROSS_REPO_MEMORY: v } as unknown as NodeJS.ProcessEnv)).toBe(true);
    }
  });
});
