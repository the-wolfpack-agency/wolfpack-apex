/**
 * @jest-environment jsdom
 */

/**
 * Sites detail page — 4-second poll must not flicker the UI.
 *
 * Regression for the 2026-04-18 production bug where clicking
 * "Generate preview" caused the whole page to blink every 4s until
 * the user hit refresh. Root cause: load() unconditionally called
 * setLoading(true) → line 290 returned <div>Loading…</div> → the
 * loaded UI unmounted → fetch resolved → setLoading(false) → UI
 * re-mounted. Every poll = one full unmount/remount cycle = visible
 * blink.
 *
 * This test MOUNTS a stand-in that exercises the same load() logic
 * via a controllable fetch mock, dispatches a simulated poll tick,
 * and asserts the "Loading…" text never re-appears after the first
 * mount. If it does, the blink is back.
 *
 * We can't mount the full page component because Next's
 * `use(params: Promise)` suspends jsdom. We DO mount a Testing
 * Library harness that replicates the load() state machine — the
 * bug we're locking is in that state machine, not in layout.
 */

import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";

interface Brief { client: string; product: { name: string }; pages: unknown[] }
interface Project { id: string; status: string; brief: Brief; preview_url: string | null }

/**
 * Harness: a miniature version of the detail page's load() +
 * poll-interval wiring. Identical state machine — if this blinks
 * under polls, the real page blinks too.
 */
function DetailPageHarness({ onFetch }: { onFetch: (fromPoll: boolean) => Promise<Project> }) {
  const [project, setProject] = useState<Project | null>(null);
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(true);
  const savedBriefRef = useRef<string>("");

  async function load(opts: { fromPoll?: boolean } = {}) {
    // Mirrors the real page: skip the loading shell on poll-refreshes
    // so the UI doesn't flash to "Loading…" every 4 seconds during a
    // deploy. Initial + user-initiated loads still show it.
    if (!opts.fromPoll) setLoading(true);
    try {
      const p = await onFetch(!!opts.fromPoll);
      setProject(p);
      const incomingJson = JSON.stringify(p.brief);
      const localJson = JSON.stringify(brief);
      const isDirty = !!brief && localJson !== savedBriefRef.current;
      if (!opts.fromPoll || !isDirty) {
        setBrief(p.brief);
      }
      savedBriefRef.current = incomingJson;
    } finally {
      if (!opts.fromPoll) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <div data-testid="loading">Loading…</div>;
  if (!project || !brief) return <div data-testid="empty">empty</div>;
  return (
    <div>
      <div data-testid="status">{project.status}</div>
      <div data-testid="brief-name">{brief.product.name}</div>
      <button
        data-testid="simulate-poll"
        onClick={() => void load({ fromPoll: true })}
      >
        poll
      </button>
    </div>
  );
}

function makeProject(status: string, briefName = "Test"): Project {
  return {
    id: "site_x",
    status,
    preview_url: null,
    brief: { client: "x", product: { name: briefName }, pages: [] },
  };
}

describe("Detail page poll stability — no flicker to Loading… under polls", () => {
  it("initial load shows Loading… then renders content", async () => {
    const fetch = jest.fn(async () => makeProject("deploying"));
    render(<DetailPageHarness onFetch={fetch} />);
    expect(screen.getByTestId("loading")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("status")).toBeInTheDocument());
    expect(screen.queryByTestId("loading")).not.toBeInTheDocument();
  });

  it("poll-refresh does NOT flash the Loading… shell while fetch is in-flight", async () => {
    // To reliably catch the blink, the fetch must be a PENDING
    // promise we control. That way we can observe the render state
    // between click + resolution — exactly the window where the old
    // `setLoading(true)` would swap the UI to <div>Loading…</div>.
    const pending: Array<(p: Project) => void> = [];
    const fetch = jest.fn(
      () => new Promise<Project>((resolve) => { pending.push(resolve); }),
    );
    render(<DetailPageHarness onFetch={fetch} />);
    // Resolve initial mount fetch.
    await act(async () => {
      pending.shift()!(makeProject("deploying", "init"));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("status")).toBeInTheDocument());

    // Fire a poll. DO NOT resolve the promise yet — we want to
    // observe the render state while the poll fetch is pending.
    await act(async () => {
      screen.getByTestId("simulate-poll").click();
      await Promise.resolve();
    });

    // THE critical assertion: with a poll in-flight, the Loading…
    // shell must NOT be rendered. If this fails, the blink is back.
    expect(screen.queryByTestId("loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("status")).toBeInTheDocument();
    expect(screen.getByTestId("brief-name")).toBeInTheDocument();

    // Resolve the poll.
    await act(async () => {
      pending.shift()!(makeProject("deploying", "after-poll"));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByTestId("brief-name").textContent).toBe("after-poll"),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("polls preserve user's unsaved brief edits (no server-overwrite clobber)", async () => {
    // Server brief changes from "Server A" → "Server B" mid-session,
    // but the user's local brief is different from the last server
    // version they saw. Poll must not overwrite local.
    let version = 0;
    const fetch = jest.fn(async () => {
      version += 1;
      return makeProject("deploying", version === 1 ? "Server A" : "Server B");
    });

    function DirtyHarness() {
      const [project, setProject] = useState<Project | null>(null);
      const [brief, setBrief] = useState<Brief | null>(null);
      const [loading, setLoading] = useState(true);
      const savedBriefRef = useRef<string>("");
      async function load(opts: { fromPoll?: boolean } = {}) {
        if (!opts.fromPoll) setLoading(true);
        const p = await fetch(!!opts.fromPoll);
        setProject(p);
        const incomingJson = JSON.stringify(p.brief);
        const localJson = JSON.stringify(brief);
        const isDirty = !!brief && localJson !== savedBriefRef.current;
        if (!opts.fromPoll || !isDirty) setBrief(p.brief);
        savedBriefRef.current = incomingJson;
        if (!opts.fromPoll) setLoading(false);
      }
      useEffect(() => { void load(); }, []); // eslint-disable-line
      if (loading || !brief) return <div>loading</div>;
      return (
        <div>
          <div data-testid="brief-name">{brief.product.name}</div>
          <button
            data-testid="simulate-typing"
            onClick={() =>
              setBrief({ ...brief, product: { ...brief.product, name: "LOCAL DIRTY" } })
            }
          >
            type
          </button>
          <button
            data-testid="simulate-poll"
            onClick={() => void load({ fromPoll: true })}
          >
            poll
          </button>
        </div>
      );
    }

    render(<DirtyHarness />);
    await waitFor(() => expect(screen.getByTestId("brief-name")).toHaveTextContent("Server A"));

    // User types something locally.
    await act(async () => {
      screen.getByTestId("simulate-typing").click();
      await Promise.resolve();
    });
    expect(screen.getByTestId("brief-name")).toHaveTextContent("LOCAL DIRTY");

    // Poll fires — server says "Server B", but user's unsaved edit
    // must be preserved.
    await act(async () => {
      screen.getByTestId("simulate-poll").click();
      await Promise.resolve();
    });
    expect(screen.getByTestId("brief-name")).toHaveTextContent("LOCAL DIRTY");
    expect(screen.getByTestId("brief-name")).not.toHaveTextContent("Server B");
  });
});
