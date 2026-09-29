/**
 * Export-preservation detector: catches an edit that drops a public export (the
 * apex `decide` deletion that broke five importers and passed the syntax check).
 */
import { extractExports, findRemovedExports, removedExportsFeedback } from "@/lib/ai-code/exports-preservation";

describe("extractExports", () => {
  it("captures declaration exports, named lists (with as), and default", () => {
    const src = `
      export function decide() {}
      export const POLICY_VERSION = "1";
      export class Gate {}
      export interface Foo {}
      export type Bar = string;
      export enum E { A }
      const x = 1, y = 2;
      export { x, y as why };
      export default Gate;
    `;
    const got = extractExports(src);
    expect([...got].sort()).toEqual(["Bar", "E", "Foo", "Gate", "POLICY_VERSION", "decide", "default", "why", "x"].sort());
  });

  it("captures re-exports and records export-* as a wildcard", () => {
    const got = extractExports(`export { riskTierFor } from "./policy";\nexport * from "./types";`);
    expect(got.has("riskTierFor")).toBe(true);
    expect(got.has("*")).toBe(true);
  });

  it("does not treat a local (non-exported) declaration as an export", () => {
    expect(extractExports(`function hidden() {}\nconst secret = 1;`).size).toBe(0);
  });
});

describe("findRemovedExports", () => {
  it("flags an export present before but gone after (the decide case)", () => {
    const before = `export function decide(){}\nexport function riskTierFor(){}`;
    const after = `export function riskTierFor(){}`; // decide dropped
    expect(findRemovedExports(before, after)).toEqual(["decide"]);
  });

  it("returns nothing when all exports are preserved (even if code changes)", () => {
    const before = `export function decide(){ return 1; }`;
    const after = `export function decide(){ return 2; } // edited body`;
    expect(findRemovedExports(before, after)).toEqual([]);
  });

  it("returns nothing when exports are ADDED (a normal additive change)", () => {
    const before = `export function decide(){}`;
    const after = `export function decide(){}\nexport function newHelper(){}`;
    expect(findRemovedExports(before, after)).toEqual([]);
  });

  it("returns nothing for a new file (no before content)", () => {
    expect(findRemovedExports("", `export const x = 1;`)).toEqual([]);
  });
});

describe("removedExportsFeedback", () => {
  it("names the removed exports per file and says restore them", () => {
    const fb = removedExportsFeedback([
      { path: "src/lib/ogiam/policy.ts", name: "decide" },
      { path: "src/lib/ogiam/policy.ts", name: "POLICY_VERSION" },
    ]);
    expect(fb).toMatch(/REMOVED public export/i);
    expect(fb).toMatch(/src\/lib\/ogiam\/policy\.ts: restore decide, POLICY_VERSION/);
    expect(fb).toMatch(/every existing export preserved/i);
  });
});
