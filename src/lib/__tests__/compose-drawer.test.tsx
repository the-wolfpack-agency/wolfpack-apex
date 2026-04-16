/**
 * @jest-environment jsdom
 */
/**
 * ComposeDrawer UI tests: render, draft save, send disables button,
 * error surface for scope_missing.
 */

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

jest.mock("@/lib/client-auth", () => ({
  jsonHeaders: () => ({ Authorization: "Bearer t", "Content-Type": "application/json" }),
  authHeaders: () => ({ Authorization: "Bearer t" }),
  fetchWithRefresh: jest.fn((url, opts) => fetch(url, opts)), fetchJsonWithRefresh: jest.fn(async (url, opts) => (await fetch(url, opts)).json()) }));

import { ComposeDrawer } from "@/components/mail/ComposeDrawer";

const fetchMock = jest.fn();

beforeAll(() => {
  (global as any).fetch = fetchMock;
});

beforeEach(() => {
  fetchMock.mockReset();
  window.sessionStorage.clear();
});

function openDrawer(onClose = jest.fn(), initialTo?: string[]) {
  return render(<ComposeDrawer open={true} onClose={onClose} initialTo={initialTo} />);
}

describe("ComposeDrawer", () => {
  it("renders when open=true, and hides when open=false", () => {
    const { rerender } = render(<ComposeDrawer open={false} onClose={() => {}} />);
    expect(screen.queryByTestId("compose-drawer")).toBeNull();
    rerender(<ComposeDrawer open={true} onClose={() => {}} />);
    expect(screen.getByTestId("compose-drawer")).toBeInTheDocument();
  });

  it("disables Send until To + Subject + Body are filled", async () => {
    openDrawer();
    const btn = screen.getByTestId("compose-send") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    // Add recipient
    const toInput = screen.getByLabelText(/To email input/i) as HTMLInputElement;
    fireEvent.change(toInput, { target: { value: "a@b.com" } });
    fireEvent.keyDown(toInput, { key: "Enter" });

    // Add subject
    const subj = screen.getByLabelText(/Subject/i) as HTMLInputElement;
    fireEvent.change(subj, { target: { value: "Hi" } });

    // Still disabled — no body
    expect((screen.getByTestId("compose-send") as HTMLButtonElement).disabled).toBe(true);

    // Add body via innerText
    const body = screen.getByTestId("compose-body");
    body.innerHTML = "hello world";
    // Fire input to trigger state sync
    fireEvent.input(body);

    await waitFor(() => {
      expect((screen.getByTestId("compose-send") as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("persists draft subject into sessionStorage", async () => {
    openDrawer();
    const subj = screen.getByLabelText(/Subject/i) as HTMLInputElement;
    fireEvent.change(subj, { target: { value: "My subject" } });

    await waitFor(() => {
      const raw = window.sessionStorage.getItem("instinct.mail.compose.draft.v1");
      expect(raw).not.toBeNull();
      const d = JSON.parse(raw!);
      expect(d.subject).toBe("My subject");
    });
  });

  it("surfaces scope_missing error clearly", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: "forbidden", code: "scope_missing", scope: "Mail.Send" }),
    });

    openDrawer();

    fireEvent.change(screen.getByLabelText(/To email input/i), { target: { value: "a@b.com" } });
    fireEvent.keyDown(screen.getByLabelText(/To email input/i), { key: "Enter" });
    fireEvent.change(screen.getByLabelText(/Subject/i), { target: { value: "Hi" } });
    const body = screen.getByTestId("compose-body");
    body.innerHTML = "hello";
    fireEvent.input(body);

    await waitFor(() => expect((screen.getByTestId("compose-send") as HTMLButtonElement).disabled).toBe(false));

    await act(async () => {
      fireEvent.click(screen.getByTestId("compose-send"));
    });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/Mail\.Send/);
      expect(screen.getByRole("alert").textContent).toMatch(/reconnect/i);
    });
  });

  it("disables Send while sending", async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    fetchMock.mockReturnValueOnce(new Promise((r) => { resolveFetch = r; }));

    openDrawer();
    fireEvent.change(screen.getByLabelText(/To email input/i), { target: { value: "a@b.com" } });
    fireEvent.keyDown(screen.getByLabelText(/To email input/i), { key: "Enter" });
    fireEvent.change(screen.getByLabelText(/Subject/i), { target: { value: "Hi" } });
    const body = screen.getByTestId("compose-body");
    body.innerHTML = "hello";
    fireEvent.input(body);
    await waitFor(() => expect((screen.getByTestId("compose-send") as HTMLButtonElement).disabled).toBe(false));

    act(() => {
      fireEvent.click(screen.getByTestId("compose-send"));
    });
    await waitFor(() => {
      expect((screen.getByTestId("compose-send") as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByTestId("compose-send").textContent).toMatch(/Sending/);
    });

    // Resolve to let cleanup happen
    await act(async () => {
      resolveFetch({ ok: true, status: 202, json: async () => ({ id: "m1" }) });
    });
  });
});
