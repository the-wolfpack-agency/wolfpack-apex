/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
}));

import TicketForm from "@/app/(dashboard)/support/_components/TicketForm";

beforeEach(() => mockFetchWithRefresh.mockReset());

describe("<TicketForm />", () => {
  test("blocks submit when title is empty", async () => {
    const onCreated = jest.fn();
    render(<TicketForm onCreated={onCreated} />);
    fireEvent.change(screen.getByTestId("ticket-form-body"), {
      target: { value: "Body only, no title" },
    });
    fireEvent.submit(screen.getByTestId("ticket-form"));
    await waitFor(() => {
      expect(
        screen.getByTestId("ticket-form-validation-error").textContent,
      ).toMatch(/short title/);
    });
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  test("blocks submit when body is empty", async () => {
    const onCreated = jest.fn();
    render(<TicketForm onCreated={onCreated} />);
    fireEvent.change(screen.getByTestId("ticket-form-title"), {
      target: { value: "Title only" },
    });
    fireEvent.submit(screen.getByTestId("ticket-form"));
    await waitFor(() => {
      expect(
        screen.getByTestId("ticket-form-validation-error").textContent,
      ).toMatch(/Describe what's happening/);
    });
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();
  });

  test("submits to POST /api/support/tickets with the correct payload", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: "tkt_new",
        title: "Login fails",
        body: "AADSTS20012",
        category: "m365",
        severity: "p1",
        status: "drafted",
        draft_response: "Try this…",
        created_at: new Date().toISOString(),
      }),
    });
    const onCreated = jest.fn();
    render(<TicketForm onCreated={onCreated} />);

    fireEvent.change(screen.getByTestId("ticket-form-title"), {
      target: { value: "Login fails" },
    });
    fireEvent.change(screen.getByTestId("ticket-form-body"), {
      target: { value: "AADSTS20012 every time" },
    });
    fireEvent.change(screen.getByTestId("ticket-form-diagnostic"), {
      target: { value: "AADSTS20012: WS-Federation issuer" },
    });
    fireEvent.change(screen.getByTestId("ticket-form-category"), {
      target: { value: "m365" },
    });
    fireEvent.change(screen.getByTestId("ticket-form-severity"), {
      target: { value: "p1" },
    });

    fireEvent.submit(screen.getByTestId("ticket-form"));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1);
    });

    const [url, init] = mockFetchWithRefresh.mock.calls[0];
    expect(url).toBe("/api/support/tickets");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse(((init as RequestInit).body as string) ?? "{}");
    expect(body).toEqual({
      title: "Login fails",
      body: "AADSTS20012 every time",
      diagnostic_text: "AADSTS20012: WS-Federation issuer",
      category: "m365",
      severity: "p1",
      /* Audience defaults to 'internal' when the operator does not
         explicitly switch it. The new tests below cover the explicit
         switch path. */
      audience: "internal",
    });

    expect(onCreated.mock.calls[0][0].id).toBe("tkt_new");
  });

  test("renders the loading state while the request is in flight", async () => {
    let resolve: (v: unknown) => void = () => {};
    const pending = new Promise((r) => {
      resolve = r;
    });
    mockFetchWithRefresh.mockReturnValueOnce(pending);

    render(<TicketForm onCreated={() => {}} />);
    fireEvent.change(screen.getByTestId("ticket-form-title"), {
      target: { value: "T" },
    });
    fireEvent.change(screen.getByTestId("ticket-form-body"), {
      target: { value: "B" },
    });
    fireEvent.submit(screen.getByTestId("ticket-form"));

    await waitFor(() => {
      expect(screen.getByTestId("ticket-form-loading-hint")).toBeInTheDocument();
    });
    expect(screen.getByTestId("ticket-form-submit").textContent).toMatch(
      /Drafting your response/,
    );

    // Cleanup so the promise resolves.
    resolve({
      ok: true,
      status: 200,
      json: async () => ({
        id: "x",
        title: "T",
        body: "B",
        category: "general",
        severity: "p2",
        status: "drafted",
        created_at: new Date().toISOString(),
      }),
    });
  });

  test("audience defaults to 'internal' on render with the matching hint", () => {
    render(<TicketForm onCreated={() => {}} />);
    const select = screen.getByTestId(
      "ticket-form-audience",
    ) as HTMLSelectElement;
    expect(select.value).toBe("internal");
    /* Hint copy explains routing so the operator picks consciously. */
    expect(
      screen.getByTestId("ticket-form-audience-hint").textContent,
    ).toMatch(/your personal address/);
  });

  test("switching audience to client posts audience='client' and updates the hint", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        id: "tkt_client",
        title: "VIP issue",
        body: "VIP body",
        category: "general",
        severity: "p2",
        status: "drafted",
        audience: "client",
        created_at: new Date().toISOString(),
      }),
    });
    const onCreated = jest.fn();
    render(<TicketForm onCreated={onCreated} />);

    fireEvent.change(screen.getByTestId("ticket-form-audience"), {
      target: { value: "client" },
    });
    /* Hint flips to the support@ routing once 'client' is picked. */
    expect(
      screen.getByTestId("ticket-form-audience-hint").textContent,
    ).toMatch(/support@thewolfpack\.agency/);

    fireEvent.change(screen.getByTestId("ticket-form-title"), {
      target: { value: "VIP issue" },
    });
    fireEvent.change(screen.getByTestId("ticket-form-body"), {
      target: { value: "VIP body" },
    });
    fireEvent.submit(screen.getByTestId("ticket-form"));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledTimes(1);
    });
    const init = mockFetchWithRefresh.mock.calls[0][1] as RequestInit;
    const body = JSON.parse((init.body as string) ?? "{}");
    expect(body.audience).toBe("client");
  });

  test("renders a friendly server error on non-2xx", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "anthropic key missing" }),
    });
    render(<TicketForm onCreated={() => {}} />);
    fireEvent.change(screen.getByTestId("ticket-form-title"), {
      target: { value: "T" },
    });
    fireEvent.change(screen.getByTestId("ticket-form-body"), {
      target: { value: "B" },
    });
    fireEvent.submit(screen.getByTestId("ticket-form"));
    await waitFor(() => {
      expect(
        screen.getByTestId("ticket-form-server-error").textContent,
      ).toMatch(/anthropic key missing/);
    });
  });
});
