import { worldOutlinePaths } from "@/lib/geo/world-outline";

describe("world outline", () => {
  it("produces one closed SVG path per continent, scaled into the box", () => {
    const paths = worldOutlinePaths(720, 360);
    expect(paths.length).toBeGreaterThanOrEqual(6);
    for (const d of paths) {
      expect(d.startsWith("M")).toBe(true);
      expect(d.endsWith("Z")).toBe(true);
    }
    const nums = paths.join(" ").match(/-?\d+\.\d+/g)!.map(Number);
    expect(Math.max(...nums)).toBeLessThanOrEqual(720);
    expect(Math.min(...nums)).toBeGreaterThanOrEqual(0);
  });

  it("scales with the box size", () => {
    const small = worldOutlinePaths(360, 180);
    const nums = small.join(" ").match(/-?\d+\.\d+/g)!.map(Number);
    expect(Math.max(...nums)).toBeLessThanOrEqual(360);
  });
});
