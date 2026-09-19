import { assessDeceptionCoverage } from "@/lib/forcefield/deception-coverage";

const c = (kind: string, active = true) => ({ kind: kind as never, active });

describe("assessDeceptionCoverage", () => {
  it("flags a completely unseeded grid as 'no traps, not safe'", () => {
    const cov = assessDeceptionCoverage([], 0);
    expect(cov.kindsSeeded).toBe(0);
    expect(cov.gaps).toEqual(["token", "route", "row", "tool"]);
    expect(cov.assessment).toMatch(/no traps, not a safe site/i);
  });

  it("reads low trips on a full grid as expected-by-design, not weak", () => {
    const cov = assessDeceptionCoverage([c("token"), c("route"), c("row"), c("tool")], 2);
    expect(cov.kindsSeeded).toBe(4);
    expect(cov.gaps).toEqual([]);
    expect(cov.assessment).toMatch(/expected to be low by design/i);
  });

  it("names the missing kinds when the grid is thin (few traps, not few trips)", () => {
    const cov = assessDeceptionCoverage([c("route"), c("route")], 2);
    expect(cov.kindsSeeded).toBe(1);
    expect(cov.gaps).toEqual(["token", "row", "tool"]);
    expect(cov.byKind.find((k) => k.kind === "route")!.active).toBe(2);
    expect(cov.assessment).toMatch(/few traps/i);
  });

  it("ignores inactive (retired) decoys", () => {
    const cov = assessDeceptionCoverage([c("token", false), c("route", true)], 0);
    expect(cov.byKind.find((k) => k.kind === "token")!.seeded).toBe(false);
    expect(cov.totalActive).toBe(1);
  });
});
