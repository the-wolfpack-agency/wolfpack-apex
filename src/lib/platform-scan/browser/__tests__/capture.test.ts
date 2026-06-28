/**
 * Tests for the read-only floor and capturePage, using a hand-rolled mock ScanPage
 * (no real browser, no network). Proves:
 *  - the safety floor lets GET/HEAD through and aborts everything that mutates,
 *  - capturePage threads console/CSP/failed-request signals and the injected clock
 *    into a raw PageObservation (it does NOT classify - that is the server's job).
 */
import {
  installReadOnlyFloor,
  capturePage,
  type ScanPage,
  type ScanRoute,
  type ScanConsoleMessage,
  type ScanResponse,
} from "../capture";
import type { AxeViolation, UiElement } from "../classify";

function mockRoute(method: string): {
  route: ScanRoute;
  calls: { continued: number; aborted: number };
} {
  const calls = { continued: 0, aborted: 0 };
  const route: ScanRoute = {
    request: () => ({ method: () => method }),
    continue: () => {
      calls.continued++;
    },
    abort: () => {
      calls.aborted++;
    },
  };
  return { route, calls };
}

describe("installReadOnlyFloor", () => {
  async function runFloorWith(method: string) {
    let handler: ((route: ScanRoute) => Promise<void> | void) | null = null;
    const page = {
      route: (_pattern: string, h: (route: ScanRoute) => Promise<void> | void) => {
        handler = h;
      },
    } as unknown as ScanPage;
    await installReadOnlyFloor(page);
    const { route, calls } = mockRoute(method);
    await handler!(route);
    return calls;
  }

  it("GET -> continue() called, abort() not", async () => {
    const calls = await runFloorWith("GET");
    expect(calls.continued).toBe(1);
    expect(calls.aborted).toBe(0);
  });

  it("HEAD -> continue() called", async () => {
    const calls = await runFloorWith("HEAD");
    expect(calls.continued).toBe(1);
    expect(calls.aborted).toBe(0);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "%s -> abort() called, continue() not (read-only safety floor)",
    async (method) => {
      const calls = await runFloorWith(method);
      expect(calls.aborted).toBe(1);
      expect(calls.continued).toBe(0);
    },
  );

  it("lower-case get is still allowed (case-insensitive)", async () => {
    const calls = await runFloorWith("get");
    expect(calls.continued).toBe(1);
    expect(calls.aborted).toBe(0);
  });
});

describe("capturePage", () => {
  interface MockPageOptions {
    elements?: UiElement[];
    cspViolations?: string[];
    rendered?: boolean;
    status?: number;
    emitConsoleError?: string;
    emitFailedRequest?: { url: string; status: number };
    throwOnGoto?: boolean;
  }

  function makeMockPage(opts: MockPageOptions): ScanPage {
    const consoleHandlers: ((m: ScanConsoleMessage) => void)[] = [];
    const responseHandlers: ((r: ScanResponse) => void)[] = [];
    return {
      route: () => {},
      addInitScript: () => {},
      on: ((event: string, handler: (arg: unknown) => void) => {
        if (event === "console") consoleHandlers.push(handler as (m: ScanConsoleMessage) => void);
        if (event === "response") responseHandlers.push(handler as (r: ScanResponse) => void);
      }) as ScanPage["on"],
      goto: async () => {
        if (opts.throwOnGoto) throw new Error("nav failed");
        // Emit the canned page events at navigation time.
        if (opts.emitConsoleError) {
          for (const h of consoleHandlers) {
            h({ type: () => "error", text: () => opts.emitConsoleError! });
          }
        }
        if (opts.emitFailedRequest) {
          for (const h of responseHandlers) {
            h({
              status: () => opts.emitFailedRequest!.status,
              url: () => opts.emitFailedRequest!.url,
            });
          }
        }
        return opts.status === undefined ? null : { status: () => opts.status! };
      },
      evaluate: (async (fn: () => unknown) => {
        const src = fn.toString();
        if (src.includes("collectUiElements") || src.includes("INTERACTIVE_SELECTOR") || src.includes("querySelectorAll")) {
          return opts.elements ?? [];
        }
        if (src.includes("__cspViolations")) return opts.cspViolations ?? [];
        if (src.includes("innerText")) return opts.rendered ?? true;
        return undefined;
      }) as ScanPage["evaluate"],
    } as ScanPage;
  }

  it("returns a raw observation with injected durationMs and canned elements", async () => {
    let t = 1000;
    const now = () => {
      const v = t;
      t += 250; // first call = start, second call = end
      return v;
    };
    const elements: UiElement[] = [{ tag: "button", interactive: true }];
    const page = makeMockPage({ elements, status: 200, rendered: true });
    const obs = await capturePage(page, { route: "/x", journey: "ux" }, { now });
    expect(obs.route).toBe("/x");
    expect(obs.journey).toBe("ux");
    expect(obs.status).toBe(200);
    expect(obs.durationMs).toBe(250);
    expect(obs.elements).toEqual(elements);
    expect(obs.renderedContent).toBe(true);
  });

  it("captures a console error and a failed 401 request into the observation", async () => {
    const page = makeMockPage({
      status: 200,
      emitConsoleError: "ReferenceError: x is not defined",
      emitFailedRequest: { url: "https://t/api/me", status: 401 },
    });
    const obs = await capturePage(page, { route: "/dashboard", journey: "dashboard" });
    expect(obs.consoleErrors).toEqual(["ReferenceError: x is not defined"]);
    expect(obs.failedRequests).toEqual([{ url: "https://t/api/me", status: 401 }]);
  });

  it("captures CSP violations read back from the page", async () => {
    const page = makeMockPage({
      status: 200,
      cspViolations: ["script-src https://evil.test"],
    });
    const obs = await capturePage(page, { route: "/", journey: "landing" });
    expect(obs.cspViolations).toEqual(["script-src https://evil.test"]);
  });

  it("a navigation that throws leaves status undefined and does not reject", async () => {
    const page = makeMockPage({ throwOnGoto: true, rendered: false });
    const obs = await capturePage(page, { route: "/boom", journey: "boom" });
    expect(obs.status).toBeUndefined();
    expect(obs.renderedContent).toBe(false);
  });

  it("no runAxe dep -> axeViolations is undefined (back-compat, unchanged)", async () => {
    const page = makeMockPage({ status: 200, rendered: true });
    const obs = await capturePage(page, { route: "/x", journey: "ux" });
    expect(obs.axeViolations).toBeUndefined();
  });

  it("with a runAxe dep -> observation.axeViolations is populated from the runner", async () => {
    const canned: AxeViolation[] = [
      { id: "color-contrast", impact: "serious", help: "contrast", helpUrl: "u", nodeCount: 4 },
    ];
    let calledWith: unknown = null;
    const page = makeMockPage({ status: 200, rendered: true });
    const obs = await capturePage(
      page,
      { route: "/x", journey: "ux" },
      {
        runAxe: async (p) => {
          calledWith = p;
          return canned;
        },
      },
    );
    expect(obs.axeViolations).toEqual(canned);
    expect(calledWith).toBe(page); // the page is threaded into the runner
  });

  it("a runAxe dep that throws is swallowed (axeViolations undefined, capture still succeeds)", async () => {
    const page = makeMockPage({ status: 200, rendered: true });
    const obs = await capturePage(
      page,
      { route: "/x", journey: "ux" },
      {
        runAxe: async () => {
          throw new Error("axe injection failed");
        },
      },
    );
    expect(obs.axeViolations).toBeUndefined();
    expect(obs.status).toBe(200); // rest of the capture is intact
  });
});
