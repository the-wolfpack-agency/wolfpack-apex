/**
 * A slow provider must not become the whole search.
 *
 * MEASURED IN PRODUCTION over seven days of real traffic, in milliseconds:
 *
 *   Microsoft Teams channels   avg 5515   p95 22454   max 129458
 *   Microsoft Teams chats      avg  594   p95  2681   max   5024
 *   CRM                        avg 1168   p95  1805   max   3116
 *   Documents                  avg  705   p95  1187   max   3321
 *   SharePoint                 avg  403   p95  1615   max   2181
 *   Instinct knowledge         avg   38   p95   102   max    219
 *
 * One provider is the entire problem. The fan-out is parallel, so the slowest
 * provider IS the search: somebody typing a question waited on Teams channels
 * and on nothing else. Two twenty-second searches were reported from real use
 * on 2026-08-28, and twenty seconds of blank screen reads as broken.
 *
 * These tests hold the budget to the two things that matter: the fast results
 * still arrive, and a provider that ran out of time is recorded as SLOW rather
 * than as having found nothing. The second is the same distinction this
 * codebase has been drawing all week, one layer down.
 */

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));
/* A GETTER, NOT A VALUE. The factory runs once when the mocked module is first
   required, so returning the array directly captured it while it was still
   empty and every test saw zero providers. Reading it lazily lets each test
   set the provider list before runSearch asks for it. */
jest.mock("@/lib/search/providers", () => ({
  get SEARCH_PROVIDERS() {
    return mockProviders;
  },
}));

// eslint-disable-next-line no-var
var mockProviders: unknown[] = [];

import { runSearch } from "@/lib/search/runSearch";

const CTX = { userId: "u1", workspaceId: "default" };

function fastProvider() {
  return {
    type: "knowledge",
    name: "Instinct knowledge",
    countKey: "knowledge",
    isEnabled: () => true,
    search: async () => [
      { type: "knowledge", id: "1", title: "Found it", snippet: "s", timestamp: "", url: "/k/1" },
    ],
  };
}

/** Never settles, the way a hung Graph call behaves. */
function hangingProvider() {
  return {
    type: "channel",
    name: "Microsoft Teams channels",
    countKey: "channels",
    isEnabled: () => true,
    search: () => new Promise<never[]>(() => undefined),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("the provider time budget", () => {
  it("returns the fast provider's results rather than waiting forever", async () => {
    mockProviders = [fastProvider(), hangingProvider()];
    const pending = runSearch({ query: "anything", limit: 10 }, CTX);
    await jest.advanceTimersByTimeAsync(7_000);
    const res = await pending;

    expect(res.results.map((r) => r.title)).toContain("Found it");
  });

  /* THE DISTINCTION THAT MATTERS. A provider that ran out of time may have
     been about to return results. Recording it as "found nothing" would make a
     slow integration indistinguishable from an empty one, which is the exact
     confusion that let an empty task mirror read as "you have no tasks" for
     months. */
  it("records a timeout as its own event, not as a failure or an empty result", async () => {
    mockProviders = [fastProvider(), hangingProvider()];
    const pending = runSearch({ query: "anything", limit: 10 }, CTX);
    await jest.advanceTimersByTimeAsync(7_000);
    await pending;

    const events = mockTrack.mock.calls.map(([name]) => name);
    expect(events).toContain("system.search_provider_timed_out");

    const timeout = mockTrack.mock.calls.find(
      ([name]) => name === "system.search_provider_timed_out",
    );
    expect(timeout?.[3]).toEqual(
      expect.objectContaining({ provider: "Microsoft Teams channels" }),
    );
  });

  /* A provider inside its budget must be entirely unaffected. A budget that
     cut off a provider having a slightly slow day would trade a real result
     for a small time saving, which is a worse product. */
  it("does not disturb a provider that answers in time", async () => {
    mockProviders = [fastProvider()];
    const pending = runSearch({ query: "anything", limit: 10 }, CTX);
    await jest.advanceTimersByTimeAsync(100);
    const res = await pending;

    expect(res.results).toHaveLength(1);
    const events = mockTrack.mock.calls.map(([name]) => name);
    expect(events).not.toContain("system.search_provider_timed_out");
    expect(events).toContain("assistant.search_provider_executed");
  });

  /* A rejecting provider is a FAILURE, not a timeout. Relabeling one as the
     other would hide a broken integration behind a latency story. */
  it("still reports a rejecting provider as failed", async () => {
    mockProviders = [
      fastProvider(),
      {
        type: "crm",
        name: "CRM",
        countKey: "crm",
        isEnabled: () => true,
        search: async () => {
          throw new Error("connector down");
        },
      },
    ];
    const pending = runSearch({ query: "anything", limit: 10 }, CTX);
    await jest.advanceTimersByTimeAsync(100);
    const res = await pending;

    expect(res.results.map((r) => r.title)).toContain("Found it");
    const events = mockTrack.mock.calls.map(([name]) => name);
    expect(events).toContain("system.search_provider_failed");
    expect(events).not.toContain("system.search_provider_timed_out");
  });
});
