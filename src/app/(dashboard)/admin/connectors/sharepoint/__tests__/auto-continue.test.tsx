/**
 * @jest-environment jsdom
 *
 * Sync until the folder is finished, not until the clock runs out.
 *
 * #449 gave a single invocation a 240-second budget so it could close its job
 * row before the platform killed it. That made a large folder resumable and
 * left the operator clicking: TEST/General holds 2,518 files and one pass
 * ingests about 272, so finishing it by hand is ten clicks across forty
 * minutes. Reported, fairly, as "taking forever".
 *
 * The work was already idempotent, since every file the Brain holds is skipped
 * by drive-item id. All that was missing was the loop.
 *
 * The assertions that matter are the ones about stopping: a loop that cannot
 * be stopped, or that hides its own cap, is worse than the clicking.
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockGetUser = jest.fn();
const mockFetch = jest.fn();
const mockPush = jest.fn();

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock("@/lib/client-auth", () => ({
  getInstinctUser: () => mockGetUser(),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
}));

import SharepointConnectorsPage from "@/app/(dashboard)/admin/connectors/sharepoint/page";

const SOURCE = {
  id: "src-1",
  name: "TEST",
  folderPath: "General",
  siteUrl: "https://x.sharepoint.com/sites/a",
  lastSyncedAt: "2026-05-16T15:57:05.551Z",
  isActive: true,
};

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

/** A sync response that says there is more to do. */
const more = (successCount: number, remainingCount: number) =>
  ok({ result: { status: "partial", successCount, failCount: 0, fileCount: 2518, moreRemaining: true, remainingCount } });
/** A sync response for a finished folder. */
const done = (successCount: number) =>
  ok({ result: { status: "succeeded", successCount, failCount: 0, fileCount: 2518, moreRemaining: false, remainingCount: 0 } });

function wire(syncResponses: Response[]) {
  let i = 0;
  mockFetch.mockImplementation((url: string, init?: { method?: string }) => {
    if (String(url).includes("/sync") && init?.method === "POST") {
      return Promise.resolve(syncResponses[Math.min(i++, syncResponses.length - 1)]);
    }
    return Promise.resolve(ok({ sources: [SOURCE] }));
  });
  return () => i;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue({ role: "cto", id: "u1" });
});

describe("continuing automatically", () => {
  it("keeps going until the folder reports nothing remaining", async () => {
    /* THE POINT. Three passes on one click, not three clicks. */
    const calls = wire([more(272, 2246), more(272, 1974), done(300)]);
    render(<SharepointConnectorsPage />);
    await waitFor(() => expect(screen.getByTestId("sync-btn-src-1")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("sync-btn-src-1"));

    await waitFor(() => expect(screen.getByTestId("sync-notice-src-1")).toHaveTextContent(/Finished/));
    expect(calls()).toBe(3);
  });

  it("reports the running total, not just the last pass", async () => {
    /* The final pass lands a handful. Reporting only that reads as though
       almost nothing was ingested after forty minutes of work. */
    wire([more(272, 2246), done(300)]);
    render(<SharepointConnectorsPage />);
    await waitFor(() => expect(screen.getByTestId("sync-btn-src-1")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("sync-btn-src-1"));

    await waitFor(() =>
      expect(screen.getByTestId("sync-notice-src-1")).toHaveTextContent("572 file(s) ingested across 2 passes"),
    );
  });

  it("stops when asked, and says nothing was lost", async () => {
    /* A loop that cannot be interrupted is worse than the clicking it
       replaced. Everything ingested is durable, so stopping is safe and the
       message has to say so or somebody will avoid the button.
     *
     * The SECOND pass is held open deliberately. Mocked promises resolve in
     * the same tick, so without a gate the whole loop finishes before a click
     * can land and the test would pass without ever exercising cancellation. */
    let releaseSecondPass: () => void = () => {};
    const held = new Promise<void>((r) => {
      releaseSecondPass = r;
    });
    let call = 0;
    mockFetch.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (String(url).includes("/sync") && init?.method === "POST") {
        call += 1;
        if (call === 2) await held;
        return call >= 3 ? done(10) : more(272, 2246 - call * 272);
      }
      return ok({ sources: [SOURCE] });
    });

    render(<SharepointConnectorsPage />);
    await waitFor(() => expect(screen.getByTestId("sync-btn-src-1")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("sync-btn-src-1"));

    /* Pass two is in flight and blocked, so the stop control is on screen. */
    await waitFor(() => expect(screen.getByTestId("stop-sync-src-1")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("stop-sync-src-1"));
    releaseSecondPass();

    await waitFor(() =>
      expect(screen.getByTestId("sync-notice-src-1")).toHaveTextContent(/Nothing is lost/),
    );
    /* And it really stopped: the third pass never ran. */
    expect(call).toBe(2);
  });

  it("does not loop forever when the remaining count never falls", async () => {
    /* A source that always reports work left would spin until the tab is
       closed, hammering Graph. The cap fires and says why, rather than
       stopping quietly with a green tick over a half-ingested folder. */
    wire([more(0, 2518)]);
    render(<SharepointConnectorsPage />);
    await waitFor(() => expect(screen.getByTestId("sync-btn-src-1")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("sync-btn-src-1"));

    await waitFor(
      () => expect(screen.getByTestId("sync-error-src-1")).toHaveTextContent(/Stopped after 40 passes/),
      { timeout: 10_000 },
    );
    expect(screen.getByTestId("sync-error-src-1")).toHaveTextContent(/not reducing the remaining count/);
  }, 15_000);

  it("a folder that fits still finishes in one pass", async () => {
    /* The negative. Looping must not turn an ordinary sync into several. */
    const calls = wire([done(17)]);
    render(<SharepointConnectorsPage />);
    await waitFor(() => expect(screen.getByTestId("sync-btn-src-1")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("sync-btn-src-1"));

    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("stop-sync-src-1")).not.toBeInTheDocument());
    expect(calls()).toBe(1);
  });
});
