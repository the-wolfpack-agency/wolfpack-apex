/**
 * Unit tests for the spec-diff orchestration, driven by a fake page so no
 * browser, network or database is involved.
 *
 * The behaviours pinned here are the ones that make the tool trustworthy: both
 * sides are measured at the SAME viewport, the read-only floor is installed on
 * every page (a comparison must never mutate a target), and one failing viewport
 * degrades instead of destroying the run.
 */
import { runSpecDiff, type SpecDiffBrowser, type SpecDiffPage, type Viewport } from "../run";
import type { SpecItem } from "../compare";

const baseItem: SpecItem = {
  tag: "H1",
  text: "A Weekend with Porsche",
  top: 100,
  left: 50,
  width: 400,
  height: 80,
  fontSize: 76,
  lineHeight: 83.6,
  fontWeight: "400",
  fontFamily: "Porsche Next",
  textAlign: "start",
};

/** A page that answers with whatever the fixture says for the URL it was sent to. */
function fakeBrowser(byUrl: Record<string, { items: SpecItem[]; font?: { family: string; sampleWidth: number; sources: string[] } }>) {
  const opened: { url: string; viewport: Viewport | null }[] = [];
  const floored: string[] = [];
  let current = "";
  let viewport: Viewport | null = null;

  const browser: SpecDiffBrowser = {
    newPage: async (): Promise<SpecDiffPage> => ({
      goto: async (url: string) => {
        current = url;
        opened.push({ url, viewport });
        return null;
      },
      setViewportSize: async (v: Viewport) => {
        viewport = v;
      },
      evaluate: async <T,>(fn: () => T): Promise<T> => {
        const fixture = byUrl[current] ?? { items: [] };
        // Distinguish the two probes by what the caller asked for.
        const isFontProbe = fn.name.toLowerCase().includes("font");
        return (isFontProbe ? (fixture.font ?? { family: "X", sampleWidth: 1000, sources: [] }) : fixture.items) as T;
      },
      close: async () => {},
    }),
  };
  return { browser, opened, floored };
}

const VIEWPORT: Viewport = { width: 1512, height: 950 };

describe("runSpecDiff", () => {
  it("measures both sides and reports a clean run when they match", async () => {
    const { browser } = fakeBrowser({
      "https://proto.test/": { items: [baseItem] },
      "https://ours.test/": { items: [baseItem] },
    });
    const run = await runSpecDiff({ specUrl: "https://proto.test/", targetUrl: "https://ours.test/", viewports: [VIEWPORT] }, browser);
    expect(run.summary.clean).toBe(true);
    expect(run.results).toHaveLength(1);
    expect(run.results[0].matched).toBe(1);
    expect(run.errors).toHaveLength(0);
  });

  it("surfaces a real difference with its delta", async () => {
    const { browser } = fakeBrowser({
      "https://proto.test/": { items: [{ ...baseItem, top: 273 }] },
      "https://ours.test/": { items: [{ ...baseItem, top: 100 }] },
    });
    const run = await runSpecDiff({ specUrl: "https://proto.test/", targetUrl: "https://ours.test/", viewports: [VIEWPORT] }, browser);
    expect(run.summary.clean).toBe(false);
    expect(run.results[0].diffs[0].fields[0]).toMatchObject({ field: "top", spec: 273, ours: 100, delta: -173 });
  });

  it("measures BOTH sides at the same viewport, which is the whole point", async () => {
    const { browser, opened } = fakeBrowser({ "https://proto.test/": { items: [] }, "https://ours.test/": { items: [] } });
    const viewports = [
      { width: 1512, height: 950 },
      { width: 390, height: 844 },
    ];
    await runSpecDiff({ specUrl: "https://proto.test/", targetUrl: "https://ours.test/", viewports }, browser);
    expect(opened).toHaveLength(4);
    expect(opened[0].viewport).toEqual(viewports[0]);
    expect(opened[1].viewport).toEqual(viewports[0]);
    expect(opened[2].viewport).toEqual(viewports[1]);
    expect(opened[3].viewport).toEqual(viewports[1]);
  });

  it("installs the read-only floor on every page it opens", async () => {
    const { browser } = fakeBrowser({ "https://proto.test/": { items: [] }, "https://ours.test/": { items: [] } });
    const installFloor = jest.fn(async () => {});
    await runSpecDiff({ specUrl: "https://proto.test/", targetUrl: "https://ours.test/", viewports: [VIEWPORT], installFloor }, browser);
    expect(installFloor).toHaveBeenCalledTimes(2);
  });

  it("authenticates only the target, never the prototype", async () => {
    const { browser } = fakeBrowser({ "https://proto.test/": { items: [] }, "https://ours.test/": { items: [] } });
    const authenticateTarget = jest.fn(async () => {});
    await runSpecDiff({ specUrl: "https://proto.test/", targetUrl: "https://ours.test/", viewports: [VIEWPORT], authenticateTarget }, browser);
    expect(authenticateTarget).toHaveBeenCalledTimes(1);
  });

  it("records a failing viewport and keeps the rest of the run", async () => {
    let calls = 0;
    const browser: SpecDiffBrowser = {
      newPage: async () => {
        calls += 1;
        if (calls === 1) throw new Error("navigation timeout");
        return {
          goto: async () => null,
          evaluate: async <T,>(fn: () => T) => (fn.name.toLowerCase().includes("font") ? { family: "X", sampleWidth: 1, sources: [] } : []) as T,
          setViewportSize: async () => {},
          close: async () => {},
        };
      },
    };
    const onError = jest.fn();
    const run = await runSpecDiff(
      { specUrl: "https://proto.test/", targetUrl: "https://ours.test/", viewports: [VIEWPORT, { width: 390, height: 844 }], onError },
      browser,
    );
    expect(run.errors).toHaveLength(1);
    expect(run.errors[0].message).toMatch(/navigation timeout/);
    expect(run.results).toHaveLength(1);
    expect(onError).toHaveBeenCalled();
  });

  it("carries the tolerance through to the comparison", async () => {
    const { browser } = fakeBrowser({
      "https://proto.test/": { items: [{ ...baseItem, top: 100 }] },
      "https://ours.test/": { items: [{ ...baseItem, top: 102 }] },
    });
    const loose = await runSpecDiff({ specUrl: "https://proto.test/", targetUrl: "https://ours.test/", viewports: [VIEWPORT], tolerancePx: 5 }, browser);
    expect(loose.summary.totalDiffs).toBe(0);
    const strict = await runSpecDiff({ specUrl: "https://proto.test/", targetUrl: "https://ours.test/", viewports: [VIEWPORT], tolerancePx: 0.5 }, browser);
    expect(strict.summary.totalDiffs).toBe(1);
    expect(strict.tolerancePx).toBe(0.5);
  });
});
