/**
 * Export grounding - the fix that would have PREVENTED #229 at the source: put a
 * module's real exported names in front of the author so it never invents one.
 */
import { toImportSpecifier, exportsEntries, buildKnownExportsBlock } from "@/lib/ai-code/export-grounding";

describe("toImportSpecifier", () => {
  it("reverses a @/* -> src/ alias (apex shape)", () => {
    expect(toImportSpecifier("src/lib/admin/analytics.ts", { "@/": "src/" })).toBe("@/lib/admin/analytics");
  });
  it("reverses a @/* -> ./ alias (WWP shape, repo root)", () => {
    expect(toImportSpecifier("lib/admin/guest-profile.ts", { "@/": "" })).toBe("@/lib/admin/guest-profile");
  });
  it("drops an /index suffix", () => {
    expect(toImportSpecifier("src/lib/search/providers/index.ts", { "@/": "src/" })).toBe("@/lib/search/providers");
  });
  it("prefers the most specific (longest-target) alias", () => {
    const map = { "@/": "src/", "@admin/": "src/lib/admin/" };
    expect(toImportSpecifier("src/lib/admin/team.ts", map)).toBe("@admin/team");
  });
});

describe("exportsEntries + buildKnownExportsBlock", () => {
  const aliasMap = { "@/": "" }; // WWP shape

  it("lists the exact exports of each module, mapped to its import specifier", () => {
    const files = [
      { path: "lib/admin/guest-profile.ts", content: "export function guestPreferenceProfile() {}" },
      { path: "lib/admin/analytics.ts", content: "export async function recordEvent() {}" },
      { path: "lib/admin/guest-export.ts", content: "export function guestsToCsv() {}\nexport function guestExportFilename() {}\nexport type GuestExportRow = {};" },
    ];
    const block = buildKnownExportsBlock(exportsEntries(files, aliasMap));
    expect(block).toMatch(/KNOWN EXPORTS/);
    expect(block).toMatch(/@\/lib\/admin\/guest-profile: guestPreferenceProfile/);
    expect(block).toMatch(/@\/lib\/admin\/analytics: recordEvent/);
    expect(block).toMatch(/@\/lib\/admin\/guest-export:.*guestsToCsv.*guestExportFilename.*GuestExportRow/);
  });

  it("would have grounded the #229 module with the RIGHT name (no listAllGuests)", () => {
    // The module #229 hallucinated against. Its real export is guestPreferenceProfile;
    // with this block in context, there is no 'listAllGuests' to invent.
    const block = buildKnownExportsBlock(
      exportsEntries([{ path: "lib/admin/guest-profile.ts", content: "export function guestPreferenceProfile() {}" }], aliasMap),
    );
    expect(block).toContain("guestPreferenceProfile");
    expect(block).not.toContain("listAllGuests");
  });

  it("includes a default export + named exports", () => {
    const block = buildKnownExportsBlock(
      exportsEntries([{ path: "src/components/Figure.tsx", content: "export default function Figure() {}\nexport const FIG = 1;" }], { "@/": "src/" }),
    );
    expect(block).toMatch(/@\/components\/Figure:/);
    expect(block).toContain("default");
    expect(block).toContain("FIG");
  });

  it("is empty when no module has exports (never nags with noise)", () => {
    expect(buildKnownExportsBlock(exportsEntries([{ path: "lib/x.ts", content: "const private1 = 1;" }], aliasMap))).toBe("");
    expect(buildKnownExportsBlock([])).toBe("");
  });
});
