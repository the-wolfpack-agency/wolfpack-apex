/**
 * @jest-environment jsdom
 *
 * /assistant page — Related pages + Sources rendering.
 *
 * The client must render every chip the /api/assistant payload ships.
 * Analytics events fire on chip click (`assistant.link_clicked`) and
 * on source expansion (`assistant.source_viewed`).
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const fetchMock = jest.fn();

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) => fetchMock(...args),
  jsonHeaders: () => ({ "content-type": "application/json" }),
}));

beforeAll(() => {
  // jsdom doesn't polyfill scrollIntoView; the component uses it to pin
  // the messages feed to the latest entry.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});

beforeEach(() => {
  fetchMock.mockReset();
});

async function renderPage() {
  const mod = await import("@/app/(dashboard)/assistant/page");
  const Page = mod.default;
  await act(async () => {
    render(<Page />);
  });
}

test("renders Related pages chips and Sources block from the API payload", async () => {
  await renderPage();

  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        response: "Your calendar has 2 meetings today.",
        source: "tool",
        sources: [
          {
            id: "tool:calendar_availability",
            title: "From Microsoft 365 · your calendar",
            url: "/calendar",
            type: "tool",
          },
        ],
        relatedPages: [
          { domain: "calendar", label: "Calendar", href: "/calendar" },
          { domain: "meetings", label: "Meetings", href: "/meetings" },
        ],
        tokensUsed: 0,
        conversationId: "c-1",
      }),
  } as Response);

  const input = screen.getByTestId("assistant-input");
  await act(async () => {
    fireEvent.change(input, {
      target: { value: "do I have meetings on my calendar today?" },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("assistant-send"));
  });

  await waitFor(() => {
    expect(
      screen.getByText(/Your calendar has 2 meetings today/),
    ).toBeInTheDocument();
  });

  // Both related-page chips rendered.
  expect(screen.getByTestId("related-chip-calendar")).toBeInTheDocument();
  expect(screen.getByTestId("related-chip-meetings")).toBeInTheDocument();

  // Sources toggle appears and initially collapsed.
  const toggle = screen.getAllByText(/Show 1 source/)[0];
  expect(toggle).toBeInTheDocument();
});

test("clicking a related-page chip fires assistant.link_clicked analytics", async () => {
  await renderPage();

  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        response: "Goals update.",
        source: "tool",
        sources: [],
        relatedPages: [{ domain: "goals", label: "Goals & OKRs", href: "/goals" }],
        tokensUsed: 0,
      }),
  } as Response);

  const input = screen.getByTestId("assistant-input");
  await act(async () => {
    fireEvent.change(input, { target: { value: "show my OKRs" } });
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("assistant-send"));
  });

  const chip = await screen.findByTestId("related-chip-goals");
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
  } as Response);

  await act(async () => {
    fireEvent.click(chip);
  });

  // /api/analytics beacon call with the link_clicked event.
  await waitFor(() => {
    const analyticsCall = fetchMock.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0] === "/api/analytics",
    );
    expect(analyticsCall).toBeDefined();
    const body = JSON.parse((analyticsCall?.[1] as RequestInit).body as string);
    expect(body.event).toBe("assistant.link_clicked");
    expect(body.metadata.domain).toBe("goals");
  });
});

test("expanding Sources block fires assistant.source_viewed analytics", async () => {
  await renderPage();

  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        response: "Auth uses bearer tokens.",
        source: "knowledge_cache",
        sources: [
          {
            id: "kb-1",
            title: "How does auth work?",
            url: "/knowledge?entry=kb-1",
            type: "knowledge",
          },
        ],
        relatedPages: [],
        tokensUsed: 0,
      }),
  } as Response);

  const input = screen.getByTestId("assistant-input");
  await act(async () => {
    fireEvent.change(input, { target: { value: "how does auth work" } });
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("assistant-send"));
  });

  const toggle = await screen.findByText(/Show 1 source/);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({}),
  } as Response);

  await act(async () => {
    fireEvent.click(toggle);
  });

  await waitFor(() => {
    expect(screen.getByText(/How does auth work/)).toBeInTheDocument();
  });

  const analyticsCall = fetchMock.mock.calls.find(
    (c) => typeof c[0] === "string" && c[0] === "/api/analytics",
  );
  expect(analyticsCall).toBeDefined();
  const body = JSON.parse((analyticsCall?.[1] as RequestInit).body as string);
  expect(body.event).toBe("assistant.source_viewed");
  expect(body.metadata.source_type).toBe("knowledge");
});

test("does NOT render Related pages row when the payload has no relatedPages", async () => {
  await renderPage();

  fetchMock.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        response: "Hi there.",
        source: "ai",
        sources: [],
        // relatedPages intentionally absent
        tokensUsed: 10,
      }),
  } as Response);

  const input = screen.getByTestId("assistant-input");
  await act(async () => {
    fireEvent.change(input, { target: { value: "hello" } });
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("assistant-send"));
  });

  await waitFor(() => {
    expect(screen.getByText(/Hi there/)).toBeInTheDocument();
  });

  expect(screen.queryByText(/Related pages:/)).not.toBeInTheDocument();
});
