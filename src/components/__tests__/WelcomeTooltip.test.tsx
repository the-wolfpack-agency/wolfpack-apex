/**
 * @jest-environment jsdom
 */

import "@testing-library/jest-dom";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const fetchMock = jest.fn();

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) => fetchMock(...args),
  jsonHeaders: () => ({ "content-type": "application/json" }),
}));

import WelcomeTooltip from "@/components/WelcomeTooltip";

beforeEach(() => fetchMock.mockReset());

function mockShouldShow(value: boolean) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === "/api/me/welcome-tooltip" && (!init || !init.method || init.method === "GET")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ should_show: value }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
  });
}

describe("<WelcomeTooltip />", () => {
  it("renders nothing when the API says should_show=false", async () => {
    mockShouldShow(false);
    render(<WelcomeTooltip />);
    // Give the effect one microtask to resolve.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("welcome-tooltip")).toBeNull();
    expect(screen.queryByTestId("welcome-tooltip-collapsed")).toBeNull();
  });

  it("renders the expanded card with Assistant + Knowledge copy when should_show=true", async () => {
    mockShouldShow(true);
    render(<WelcomeTooltip />);
    await waitFor(() => {
      expect(screen.getByTestId("welcome-tooltip")).toBeInTheDocument();
    });
    // Headline + both beats (Assistant + Knowledge) must be present.
    expect(screen.getByText(/Meet the Wolfpack Assistant/i)).toBeInTheDocument();
    expect(screen.getByText(/sparkle button in the bottom-right/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Knowledge/i).length).toBeGreaterThan(0);
    expect(screen.getByTestId("welcome-tooltip-knowledge-cta")).toHaveAttribute(
      "href",
      "/knowledge",
    );
  });

  it("minimize → shows a collapsed pill that re-expands on click", async () => {
    mockShouldShow(true);
    render(<WelcomeTooltip />);
    await waitFor(() => {
      expect(screen.getByTestId("welcome-tooltip")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("welcome-tooltip-minimize"));
    });
    expect(screen.queryByTestId("welcome-tooltip")).toBeNull();
    expect(screen.getByTestId("welcome-tooltip-collapsed")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByTestId("welcome-tooltip-collapsed"));
    });
    expect(screen.getByTestId("welcome-tooltip")).toBeInTheDocument();
  });

  it("Got it → POSTs dismissed action and hides the card", async () => {
    mockShouldShow(true);
    render(<WelcomeTooltip />);
    await waitFor(() => {
      expect(screen.getByTestId("welcome-tooltip")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("welcome-tooltip-dismiss"));
    });
    await waitFor(() => {
      const dismissCall = fetchMock.mock.calls.find(
        (c: unknown[]) =>
          c[0] === "/api/me/welcome-tooltip" &&
          (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(dismissCall).toBeDefined();
      const body = JSON.parse((dismissCall![1] as RequestInit).body as string);
      expect(body.action).toBe("dismissed");
    });
    expect(screen.queryByTestId("welcome-tooltip")).toBeNull();
  });

  it("Open Knowledge → POSTs knowledge_clicked BEFORE the navigation", async () => {
    mockShouldShow(true);
    render(<WelcomeTooltip />);
    await waitFor(() => {
      expect(screen.getByTestId("welcome-tooltip-knowledge-cta")).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("welcome-tooltip-knowledge-cta"));
    });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c: unknown[]) =>
          c[0] === "/api/me/welcome-tooltip" &&
          (c[1] as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeDefined();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body.action).toBe("knowledge_clicked");
    });
  });
});

describe("dashboard layout mounts the tooltip (not on /assistant)", () => {
  const layout = readFileSync(
    resolve(__dirname, "../../app/(dashboard)/layout.tsx"),
    "utf8",
  );
  it("imports WelcomeTooltip", () => {
    expect(layout).toMatch(/import\s+WelcomeTooltip\s+from\s+["']@\/components\/WelcomeTooltip["']/);
  });
  it("renders <WelcomeTooltip /> inside the same suppression gate as the FAB", () => {
    expect(layout).toMatch(/<WelcomeTooltip\s*\/>/);
  });
});
