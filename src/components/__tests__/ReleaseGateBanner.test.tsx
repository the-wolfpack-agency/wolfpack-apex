/**
 * @jest-environment jsdom
 *
 * UI tests for ReleaseGateBanner (main-dashboard production-release nudge).
 * Asserts: shows with a count + link when blocking > 0; headlines the
 * most-urgent change; renders nothing when blocking is empty; surfaces the
 * honest-degrade message (never a false all-clear); fires the
 * deploy.release_gate_viewed analytics event on click-through. fetchWithRefresh
 * is mocked.
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const mockFetch = jest.fn();
const mockUser = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
  getInstinctUser: () => mockUser(),
}));

import ReleaseGateBanner, { mostUrgent } from "@/components/ReleaseGateBanner";
import type { BlockingChange } from "@/lib/deploy/release-gate";

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

const change = (over: Partial<BlockingChange> = {}): BlockingChange => ({
  number: 1,
  title: "A change",
  url: "https://github.com/x/y/pull/1",
  author: "octocat",
  headSha: "abc",
  state: "awaiting_approval",
  reason: "Waiting on your approval",
  ageHours: 2.0,
  ...over,
});

/** Route the gate GET; analytics POSTs resolve to a benign ok. */
function routeFetch(gate: unknown) {
  return (url: string) => {
    if (url.includes("/api/analytics")) return Promise.resolve(okJson({ ok: true }));
    return Promise.resolve(okJson({ ok: true, gate }));
  };
}

beforeEach(() => {
  mockUser.mockReturnValue({ role: "cto" });
  mockFetch.mockReset();
});

describe("mostUrgent", () => {
  test("ranks a failing build above an awaiting-approval change", () => {
    const u = mostUrgent([
      change({ number: 1, state: "awaiting_approval" }),
      change({ number: 2, state: "checks_failing" }),
    ]);
    expect(u?.number).toBe(2);
  });

  test("returns null for an empty list", () => {
    expect(mostUrgent([])).toBeNull();
  });
});

describe("ReleaseGateBanner", () => {
  test("shows with blocking > 0: count, most-urgent headline, and link to /admin/deployment", async () => {
    mockFetch.mockImplementation(
      routeFetch({
        productionBranch: "main",
        checkedAt: new Date().toISOString(),
        blocking: [
          change({ number: 1, state: "awaiting_approval", title: "Less urgent" }),
          change({ number: 2, state: "checks_failing", title: "Build is red", reason: "Tests are failing - fix needed" }),
        ],
      }),
    );
    render(<ReleaseGateBanner />);

    const banner = await screen.findByTestId("release-gate-banner");
    expect(banner).toHaveAttribute("data-count", "2");
    expect(banner).toHaveAttribute("href", "/admin/deployment");
    expect(banner).toHaveTextContent(/2 changes built and waiting to deploy to production/i);
    // Most-urgent (failing checks) headlines, not the awaiting-approval one.
    expect(screen.getByTestId("release-gate-banner-urgent")).toHaveTextContent(/Build is red needs tests are failing/i);
  });

  test("renders nothing when nothing is blocking production", async () => {
    mockFetch.mockImplementation(
      routeFetch({ productionBranch: "main", checkedAt: new Date().toISOString(), blocking: [] }),
    );
    const { container } = render(<ReleaseGateBanner />);
    // Give the effect a tick; the empty gate must produce no banner.
    await waitFor(() => expect(mockFetch).toHaveBeenCalled());
    expect(screen.queryByTestId("release-gate-banner")).not.toBeInTheDocument();
    expect(screen.queryByTestId("release-gate-banner-degraded")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  test("degrade shows the status-unknown message, never a false all-clear", async () => {
    mockFetch.mockImplementation(
      routeFetch({
        productionBranch: "main",
        checkedAt: new Date().toISOString(),
        blocking: [],
        degraded: { detail: "timeout" },
      }),
    );
    render(<ReleaseGateBanner />);
    const banner = await screen.findByTestId("release-gate-banner-degraded");
    expect(banner).toHaveTextContent(/Deploy status unknown - check release gate/i);
    expect(screen.queryByTestId("release-gate-banner")).not.toBeInTheDocument();
  });

  test("fires deploy.release_gate_viewed on click-through", async () => {
    mockFetch.mockImplementation(
      routeFetch({
        productionBranch: "main",
        checkedAt: new Date().toISOString(),
        blocking: [change({ number: 1 })],
      }),
    );
    render(<ReleaseGateBanner />);
    const banner = await screen.findByTestId("release-gate-banner");
    fireEvent.click(banner);
    await waitFor(() => {
      const posted = mockFetch.mock.calls.find(
        (c) => typeof c[1]?.body === "string" && c[1].body.includes("deploy.release_gate_viewed"),
      );
      expect(posted).toBeTruthy();
    });
  });
});

describe("it does not ask for what the viewer cannot have", () => {
  it("makes no request at all for somebody without the capability", async () => {
    /* Most people in a workspace are not admins, so this endpoint was being
       refused on most dashboard loads. The banner degraded correctly, so the
       cost was invisible, and a permanent expected 403 makes the production
       smoke assertion about 401s and 403s useless by teaching everybody to
       ignore it. */
    mockUser.mockReturnValue({ role: "designer" });
    render(<ReleaseGateBanner />);
    await waitFor(() => expect(mockFetch).not.toHaveBeenCalled());
  });

  it("still asks for somebody who can read it", async () => {
    mockUser.mockReturnValue({ role: "cto" });
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, gate: null }) });
    render(<ReleaseGateBanner />);
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith("/api/admin/deployment/release-gate"),
    );
  });

  it("makes no request when nobody is signed in", async () => {
    mockUser.mockReturnValue(null);
    render(<ReleaseGateBanner />);
    await waitFor(() => expect(mockFetch).not.toHaveBeenCalled());
  });
});
