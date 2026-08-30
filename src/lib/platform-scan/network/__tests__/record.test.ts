/**
 * The traffic recorder, including the attribution that gives it its value.
 */
import { createTrafficRecorder, DEFAULT_MAX_OBSERVATIONS } from "../record";
import type { ScanPage } from "../../browser/capture";

/** A page that lets a test fire responses by hand. */
function fakePage() {
  let handler: ((res: unknown) => void) | undefined;
  const page = {
    on: (event: string, h: (arg: unknown) => void) => {
      if (event === "response") handler = h;
    },
    route: () => undefined,
    addInitScript: () => undefined,
    goto: async () => null,
    evaluate: async () => ({}),
  } as unknown as ScanPage;

  const respond = (url: string, over: { status?: number; resourceType?: string } = {}) =>
    handler?.({
      url: () => url,
      status: () => over.status ?? 200,
      request: () => ({ resourceType: () => over.resourceType ?? "fetch" }),
    });

  return { page, respond };
}

describe("recording what a page contacted", () => {
  it("records a response with its url and type", () => {
    const { page, respond } = fakePage();
    const r = createTrafficRecorder(page, { now: () => 1000 });
    respond("https://vendor.example/beacon", { resourceType: "script" });

    const [obs] = r.observations();
    expect(obs.url).toBe("https://vendor.example/beacon");
    expect(obs.resourceType).toBe("script");
    expect(obs.status).toBe(200);
  });

  /* THE POINT OF THE WHOLE THING. One flat list says a system talks to six
     vendors; attribution says which screens do. */
  it("attributes each response to the screen being read", () => {
    const { page, respond } = fakePage();
    const r = createTrafficRecorder(page);

    r.attributeTo("https://app.example/settings");
    respond("https://vendor.example/a");
    r.attributeTo("https://app.example/reports");
    respond("https://vendor.example/b");

    expect(r.observations().map((o) => o.pageUrl)).toEqual([
      "https://app.example/settings",
      "https://app.example/reports",
    ]);
  });

  it("times observations from when recording started", () => {
    let t = 500;
    const { page, respond } = fakePage();
    const r = createTrafficRecorder(page, { now: () => t });
    t = 1750;
    respond("https://vendor.example/a");
    expect(r.observations()[0].atMs).toBe(1250);
  });

  it("ignores a response with no url", () => {
    let handler: ((res: unknown) => void) | undefined;
    const page = {
      on: (_e: string, h: (arg: unknown) => void) => { handler = h; },
    } as unknown as ScanPage;
    const r = createTrafficRecorder(page);
    handler?.({ url: () => "" });
    expect(r.observations()).toEqual([]);
  });

  /* One unreadable response must not lose the rest of the capture. */
  it("survives a response that throws when read", () => {
    let handler: ((res: unknown) => void) | undefined;
    const page = {
      on: (_e: string, h: (arg: unknown) => void) => { handler = h; },
    } as unknown as ScanPage;
    const r = createTrafficRecorder(page);
    handler?.({ url: () => { throw new Error("detached"); } });
    handler?.({ url: () => "https://vendor.example/a", status: () => 200 });
    expect(r.observations()).toHaveLength(1);
  });

  it("defaults a missing resource type rather than dropping the request", () => {
    const { page, respond } = fakePage();
    const r = createTrafficRecorder(page);
    respond("https://vendor.example/a", { resourceType: undefined });
    expect(r.observations()[0].resourceType).toBe("fetch");
  });

  /* A CAPPED SET THAT LOOKED COMPLETE would understate what a system contacts,
     which is the one direction this finding must never be wrong in. */
  it("caps retention and says so rather than silently truncating", () => {
    const { page, respond } = fakePage();
    const r = createTrafficRecorder(page, { maxObservations: 3 });
    for (let i = 0; i < 6; i += 1) respond(`https://vendor.example/${i}`);
    expect(r.observations()).toHaveLength(3);
    expect(r.truncated()).toBe(true);
  });

  it("does not claim truncation when it stayed under the cap", () => {
    const { page, respond } = fakePage();
    const r = createTrafficRecorder(page, { maxObservations: 3 });
    respond("https://vendor.example/a");
    expect(r.truncated()).toBe(false);
  });

  it("has a cap generous enough for a real walk", () => {
    expect(DEFAULT_MAX_OBSERVATIONS).toBeGreaterThanOrEqual(10_000);
  });

  it("can be reset without losing the listener", () => {
    const { page, respond } = fakePage();
    const r = createTrafficRecorder(page);
    respond("https://vendor.example/a");
    r.reset();
    expect(r.observations()).toEqual([]);
    respond("https://vendor.example/b");
    expect(r.observations()).toHaveLength(1);
  });

  it("hands out a copy, so a caller cannot corrupt the record", () => {
    const { page, respond } = fakePage();
    const r = createTrafficRecorder(page);
    respond("https://vendor.example/a");
    r.observations().pop();
    expect(r.observations()).toHaveLength(1);
  });
});
