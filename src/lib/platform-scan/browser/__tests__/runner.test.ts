/**
 * Tests for runUxScan orchestration with a mock browser + mock ingest (no real
 * Playwright, no network). Proves:
 *  - N routes -> N observations -> ingest called exactly once with all of them,
 *  - every page gets the read-only floor installed before capture,
 *  - a route whose page throws is isolated and does NOT abort the whole scan.
 */
import { runUxScan, type ScanBrowser } from "../runner";
import type { ScanPage, ScanRoute } from "../capture";

/** A mock ScanPage that records floor installation and serves canned signals. */
function makePage(opts: { failNewPage?: boolean; failGoto?: boolean } = {}) {
  const flooredMethods: string[] = [];
  const page = {
    route: async (_p: string, handler: (route: ScanRoute) => void) => {
      // Exercise the floor handler so the test confirms it was wired.
      const r: ScanRoute = {
        request: () => ({ method: () => "GET" }),
        continue: () => {
          flooredMethods.push("GET");
        },
        abort: () => {
          flooredMethods.push("ABORT");
        },
      };
      handler(r);
    },
    addInitScript: () => {},
    on: () => {},
    goto: async () => {
      if (opts.failGoto) throw new Error("goto boom");
      return { status: () => 200 };
    },
    evaluate: (async (fn: () => unknown) => {
      const src = fn.toString();
      if (src.includes("__cspViolations")) return [];
      if (src.includes("innerText")) return true;
      return []; // collectUiElements
    }) as ScanPage["evaluate"],
  } as ScanPage;
  return { page, getFloored: () => flooredMethods };
}

it("N routes -> N observations -> ingest called once with all observations", async () => {
  const newPageCalls: number[] = [];
  const browser: ScanBrowser = {
    newPage: async () => {
      newPageCalls.push(1);
      return makePage().page;
    },
  };

  const ingestCalls: number[] = [];
  let received: { route: string; journey: string }[] = [];

  const { observations } = await runUxScan(
    {
      baseUrl: "https://target.test",
      routes: [
        { path: "/", journey: "landing" },
        { path: "/login", journey: "login" },
        { path: "/dashboard", journey: "dashboard" },
      ],
      ingest: async (obs) => {
        ingestCalls.push(1);
        received = obs.map((o) => ({ route: o.route, journey: o.journey }));
      },
    },
    browser,
  );

  expect(newPageCalls).toHaveLength(3);
  expect(observations).toHaveLength(3);
  expect(ingestCalls).toHaveLength(1); // exactly once, with the full batch
  expect(received).toEqual([
    { route: "/", journey: "landing" },
    { route: "/login", journey: "login" },
    { route: "/dashboard", journey: "dashboard" },
  ]);
  // The observation route is the human path, not the resolved absolute URL.
  expect(observations[0].route).toBe("/");
  expect(observations[0].status).toBe(200);
});

it("forwards the runAxe dep into capturePage so axe violations land on the observation", async () => {
  const browser: ScanBrowser = { newPage: async () => makePage().page };
  const runAxe = jest.fn(async () => [
    { id: "color-contrast", impact: "serious" as const, help: "Elements must have sufficient color contrast", nodeCount: 3 },
  ]);

  const { observations } = await runUxScan(
    {
      baseUrl: "https://target.test",
      routes: [{ path: "/", journey: "landing" }],
      ingest: async () => {},
      runAxe,
    },
    browser,
  );

  expect(runAxe).toHaveBeenCalledTimes(1); // threaded through to capturePage
  expect(observations[0].axeViolations).toEqual([
    { id: "color-contrast", impact: "serious", help: expect.any(String), nodeCount: 3 },
  ]);
});

it("installs the read-only floor on every page before capture", async () => {
  const flooredPerPage: (() => string[])[] = [];
  const browser: ScanBrowser = {
    newPage: async () => {
      const m = makePage();
      flooredPerPage.push(m.getFloored);
      return m.page;
    },
  };
  await runUxScan(
    {
      baseUrl: "https://t.test",
      routes: [{ path: "/", journey: "landing" }],
      ingest: async () => {},
    },
    browser,
  );
  // The floor handler ran and allowed the GET (proving route() was installed).
  expect(flooredPerPage[0]()).toContain("GET");
});

it("a page that throws is isolated: the scan continues and still ingests", async () => {
  let call = 0;
  const browser: ScanBrowser = {
    newPage: async () => {
      call++;
      // Second route's page fails to navigate.
      return makePage({ failGoto: call === 2 }).page;
    },
  };
  const errors: string[] = [];
  let ingestCount = 0;
  let ingested: number = -1;

  const { observations } = await runUxScan(
    {
      baseUrl: "https://t.test",
      routes: [
        { path: "/a", journey: "a" },
        { path: "/b", journey: "b" }, // this one throws inside goto -> capturePage swallows; no throw
        { path: "/c", journey: "c" },
      ],
      ingest: async (obs) => {
        ingestCount++;
        ingested = obs.length;
      },
      onRouteError: ({ path, error }) => errors.push(`${path}:${error.message}`),
    },
    browser,
  );

  // capturePage swallows a goto failure (status undefined) rather than throwing,
  // so all three routes still yield an observation; ingest is still called once.
  expect(ingestCount).toBe(1);
  expect(observations).toHaveLength(3);
  expect(ingested).toBe(3);
});

it("a newPage failure for one route does not abort the whole scan", async () => {
  let call = 0;
  const browser: ScanBrowser = {
    newPage: async () => {
      call++;
      if (call === 1) throw new Error("page crash");
      return makePage().page;
    },
  };
  const errors: { path: string; error: Error }[] = [];
  let ingested = -1;

  const { observations } = await runUxScan(
    {
      baseUrl: "https://t.test",
      routes: [
        { path: "/a", journey: "a" }, // newPage throws
        { path: "/b", journey: "b" },
      ],
      ingest: async (obs) => {
        ingested = obs.length;
      },
      onRouteError: (info) => errors.push(info),
    },
    browser,
  );

  expect(errors).toHaveLength(1);
  expect(errors[0].path).toBe("/a");
  expect(observations).toHaveLength(1); // only /b survived
  expect(ingested).toBe(1);
});

it("zero routes -> ingest still called once with an empty batch (healthy run)", async () => {
  let ingestCount = 0;
  let len = -1;
  await runUxScan(
    {
      baseUrl: "https://t.test",
      routes: [],
      ingest: async (obs) => {
        ingestCount++;
        len = obs.length;
      },
    },
    { newPage: async () => makePage().page },
  );
  expect(ingestCount).toBe(1);
  expect(len).toBe(0);
});
