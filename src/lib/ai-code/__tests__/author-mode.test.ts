/**
 * Auto edit-mode: files mode can't edit an existing file, so an edit is routed to
 * anchor. Found by dogfooding (editing the factory's own imports.ts 422'd).
 */
import { pickAuthorMode } from "@/lib/ai-code/author-mode";

const tree = new Set(["src/lib/ai-code/imports.ts", "src/lib/admin/analytics.ts"]);

describe("pickAuthorMode", () => {
  it("files -> anchor when the task targets an EXISTING file (an edit)", () => {
    expect(pickAuthorMode("files", ["src/lib/ai-code/imports.ts"], tree)).toBe("anchor");
  });

  it("files stays files for a NEW file (no existing path mentioned)", () => {
    expect(pickAuthorMode("files", ["src/lib/ai-code/brand-new.ts"], tree)).toBe("files");
    expect(pickAuthorMode("files", [], tree)).toBe("files");
  });

  it("respects an explicitly pinned anchor or diff (never downgraded)", () => {
    expect(pickAuthorMode("anchor", [], tree)).toBe("anchor");
    expect(pickAuthorMode("diff", ["src/lib/ai-code/imports.ts"], tree)).toBe("diff");
  });

  it("no tree (grounding unavailable) -> files is left as-is", () => {
    expect(pickAuthorMode("files", ["src/lib/ai-code/imports.ts"], new Set())).toBe("files");
  });

  // The live large-file dogfood: the pipeline DEFAULTS to diff when the caller
  // sends no mode. An UNPINNED diff editing an existing file must redirect to
  // anchor (diff has no live base -> empty change -> 422 dead-end).
  it("UNPINNED default-diff editing an existing file -> anchor", () => {
    expect(pickAuthorMode("diff", ["src/lib/ai-code/imports.ts"], tree, false)).toBe("anchor");
  });

  it("UNPINNED default-diff for a NEW file stays diff", () => {
    expect(pickAuthorMode("diff", ["src/lib/ai-code/brand-new.ts"], tree, false)).toBe("diff");
  });

  it("an EXPLICITLY pinned diff is still respected over an existing file", () => {
    expect(pickAuthorMode("diff", ["src/lib/ai-code/imports.ts"], tree, true)).toBe("diff");
  });
});
