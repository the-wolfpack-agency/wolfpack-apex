import { parseReleaseFile } from "@/lib/release-file";

const ok = { version: "2026.10.25", title: "T", summary: "S", released_on: "2026-10-25", entries: [{ area: "Ford", category: "feature", title: "A", description: "B", how_to_use: "C", sources: ["wolfpack-ford#1"] }] };

describe("parseReleaseFile", () => {
  it("maps a release file to createRelease input and drops each entry's sources", () => {
    const r = parseReleaseFile(JSON.stringify(ok));
    expect(r).toEqual({ version: "2026.10.25", title: "T", summary: "S", released_on: "2026-10-25", published: true, entries: [{ area: "Ford", category: "feature", title: "A", description: "B", how_to_use: "C" }] });
  });
  it("refuses a file missing what the page needs, with the reason", () => {
    expect(() => parseReleaseFile(JSON.stringify({ ...ok, version: "" }))).toThrow(/"version" is required/);
    expect(() => parseReleaseFile(JSON.stringify({ ...ok, released_on: "Oct 25" }))).toThrow(/YYYY-MM-DD/);
    expect(() => parseReleaseFile(JSON.stringify({ ...ok, entries: [] }))).toThrow(/non-empty/);
    expect(() => parseReleaseFile(JSON.stringify({ ...ok, entries: [{ title: "A" }] }))).toThrow(/entry 0 needs "description"/);
  });
  it("refuses em and en dashes", () => {
    expect(() => parseReleaseFile(JSON.stringify({ ...ok, title: "A — B" }))).toThrow(/dashes/);
  });
});
