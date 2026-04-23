/**
 * @jest-environment jsdom
 *
 * The floating assistant FAB must:
 *   1. Mount on every dashboard page EXCEPT /assistant (where the
 *      full-page version renders; we don't want two InstinctChat
 *      instances racing over the same conversation state).
 *   2. Render as a small bottom-right bubble when closed — not blocking
 *      page content.
 *   3. Expand to the full chat panel when clicked.
 *   4. Fire `assistant.floating_opened` analytics on open so the
 *      learning loop sees where users invoke the assistant most.
 *
 * The layout.tsx integration is asserted at the source-text level to
 * avoid jsdom-mounting every single layout dependency (auth, nav, etc).
 * Behavior tests mount the component directly with position="floating".
 */

import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

beforeAll(() => {
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});

const fetchMock = jest.fn();

jest.mock("@/lib/client-auth", () => ({
  getInstinctToken: () => "test-token",
  clearInstinctSession: jest.fn(),
  jsonHeaders: () => ({ "content-type": "application/json" }),
  fetchWithRefresh: (...args: unknown[]) => fetchMock(...args),
}));
jest.mock("@/lib/assistant-rag-offline", () => ({
  queryAssistantWithCache: jest.fn(() => Promise.reject(new Error("no cache"))),
  RagOfflineMissError: class RagOfflineMissError extends Error {},
}));
jest.mock("@/lib/assistant-drafts-offline", () => ({
  sendAssistantMessageOffline: jest.fn(),
}));
jest.mock("@/components/RagSnapshotBadge", () => ({
  __esModule: true,
  RagSnapshotBadge: () => null,
}));

import InstinctChat from "@/components/InstinctChat";

describe("dashboard layout — floating assistant mount rules", () => {
  const layout = readFileSync(
    resolve(__dirname, "../layout.tsx"),
    "utf8",
  );

  it("imports InstinctChat", () => {
    expect(layout).toMatch(/import\s+InstinctChat\s+from\s+["']@\/components\/InstinctChat["']/);
  });

  it("mounts InstinctChat with position=\"floating\"", () => {
    expect(layout).toMatch(/<InstinctChat\s+position=["']floating["']\s*\/>/);
  });

  it("suppresses the FAB on /assistant to avoid double-mount", () => {
    // Match either pathname !== "/assistant" or pathname !== '/assistant'.
    expect(layout).toMatch(/pathname\s*!==?\s*["']\/assistant["']/);
  });

});

describe("floating FAB — closed state is unobtrusive, open works, analytics fire", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
  });

  it("closed state renders only the bottom-right bubble button (no chat panel)", () => {
    render(<InstinctChat position="floating" />);
    const fab = screen.getByTestId("floating-assistant-fab");
    expect(fab).toBeInTheDocument();
    // Sidebar / header elements must NOT render while the FAB is
    // collapsed — they'd block the page underneath.
    expect(screen.queryByText(/Wolfpack Assistant/i)).toBeNull();
  });

  it("floating panel uses dvh so it shrinks when the mobile keyboard opens", () => {
    // Regression: the panel was height: "32rem" (512px) which on
    // ~667px iPhones leaves no room for the mobile keyboard. The
    // input at the bottom of the panel ended up hidden behind the
    // keyboard. The fix caps panel height at
    // `min(32rem, calc(100dvh - 2rem))` — dvh subtracts the keyboard
    // automatically.
    const source = readFileSync(
      resolve(__dirname, "../../../components/InstinctChat.tsx"),
      "utf8",
    );
    expect(source).toMatch(/min\(32rem,\s*calc\(100dvh\s*-\s*2rem\)\)/);
    // And onFocus fallback scrollIntoView for browsers without dvh.
    expect(source).toMatch(/scrollIntoView\(\s*\{\s*block:\s*["']nearest["']/);
  });

  it("FAB icon is visually centered — viewBox compensates for the asymmetric star path", () => {
    // Regression: the Heroicons sparkle path is drawn with its
    // center-of-mass at x=9 in a 24-unit viewBox. A naive
    // viewBox="0 0 24 24" pushes the icon 3 units left of center.
    // The fix shifts the viewport via viewBox="-3 0 24 24" so the
    // star sits at visual center of the 56x56 FAB. This test locks
    // in that compensation.
    render(<InstinctChat position="floating" />);
    const icon = screen.getByTestId("floating-assistant-fab-icon");
    expect(icon.getAttribute("viewBox")).toBe("-3 0 24 24");
  });

  it("bubble is positioned fixed bottom-right with z-50 so it never blocks page content", () => {
    render(<InstinctChat position="floating" />);
    const fab = screen.getByTestId("floating-assistant-fab");
    expect(fab.className).toMatch(/fixed/);
    expect(fab.className).toMatch(/bottom-6/);
    expect(fab.className).toMatch(/right-6/);
    expect(fab.className).toMatch(/z-50/);
    // 56x56 target — doesn't swallow clicks on neighboring surface.
    expect(fab.className).toMatch(/w-14/);
    expect(fab.className).toMatch(/h-14/);
  });

  it("clicking the bubble expands to the full chat panel", async () => {
    render(<InstinctChat position="floating" />);
    const fab = screen.getByTestId("floating-assistant-fab");
    await act(async () => {
      fireEvent.click(fab);
    });
    // Panel header appears.
    await waitFor(() => {
      expect(screen.getByText(/Wolfpack Assistant/i)).toBeInTheDocument();
    });
  });

  it("firing the open event calls POST /api/analytics with assistant.floating_opened", async () => {
    render(<InstinctChat position="floating" />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("floating-assistant-fab"));
    });
    await waitFor(() => {
      const analyticsCall = fetchMock.mock.calls.find(
        (c: unknown[]) => c[0] === "/api/analytics",
      );
      expect(analyticsCall).toBeDefined();
      const body = JSON.parse((analyticsCall![1] as RequestInit).body as string);
      expect(body.event).toBe("assistant.floating_opened");
      expect(body.metadata).toHaveProperty("pathname");
    });
  });
});
