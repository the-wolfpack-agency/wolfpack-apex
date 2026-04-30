/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  getInstinctToken: () => "tok",
  getInstinctUser: () => ({ name: "Tester", email: "me@x", role: "ceo" }),
  authHeaders: () => ({ Authorization: "Bearer x" }),
}));

jest.mock("@/lib/integrations/connect", () => ({
  startMicrosoftConnect: jest.fn(),
  startQuickbooksConnect: jest.fn(),
  connectPlaud: jest.fn(),
}));

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SettingsPage from "@/app/(dashboard)/settings/page";

interface MockResponse {
  ok?: boolean;
  status?: number;
  json: () => Promise<any>;
}

function ok(body: any, status = 200): MockResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const SIG_ROW = {
  id: "sig-1",
  label: "Default",
  body: "Nick — CTO",
  isDefault: true,
};
const SIG_ROW_2 = {
  id: "sig-2",
  label: "Short",
  body: "Nick",
  isDefault: false,
};

function defaultRouter(url: string, init?: RequestInit): MockResponse {
  if (url.startsWith("/api/email-signatures") && (!init || !init.method)) {
    return ok({ signatures: [SIG_ROW, SIG_ROW_2] });
  }
  if (url.startsWith("/api/email-signatures") && init?.method === "POST") {
    return ok({ signature: { id: "sig-new", ...JSON.parse(init.body as string) } }, 201);
  }
  if (url.startsWith("/api/microsoft?action=status")) return ok({ connected: false });
  if (url.startsWith("/api/quickbooks?action=status")) return ok({ connection: { connected: false } });
  if (url.startsWith("/api/integrations/plaud?action=status"))
    return ok({ connected: false, configured: true });
  if (url.startsWith("/api/usage")) return ok({ user_id_hint: "u", lifetime: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_hits: 0, ai_calls: 0 }, last_30_days: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_hits: 0, ai_calls: 0 }, generated_at: "x" });
  if (url.startsWith("/api/analytics")) return ok({});
  return ok({});
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockFetchWithRefresh.mockImplementation((url: string, init?: RequestInit) =>
    Promise.resolve(defaultRouter(url, init)),
  );
  window.localStorage.clear();
});

async function flushPromises() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

describe("Settings — Email signatures card", () => {
  it("renders the card and lists existing signatures", async () => {
    render(<SettingsPage />);
    await flushPromises();
    expect(await screen.findByTestId("settings-email-signatures")).toBeInTheDocument();
    expect(screen.getByTestId("signature-row-sig-1")).toBeInTheDocument();
    expect(screen.getByTestId("signature-row-sig-2")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getByText("Short")).toBeInTheDocument();
  });

  it("shows a default badge on the default signature", async () => {
    render(<SettingsPage />);
    await flushPromises();
    const row = await screen.findByTestId("signature-row-sig-1");
    expect(row.textContent).toMatch(/default/i);
    /* The non-default row exposes a "Set as default" button. */
    expect(screen.getByTestId("signature-set-default-sig-2")).toBeInTheDocument();
    expect(screen.queryByTestId("signature-set-default-sig-1")).toBeNull();
  });

  it("creates a new signature via the inline form", async () => {
    render(<SettingsPage />);
    await flushPromises();

    const labelInput = await screen.findByTestId("signature-new-label");
    const bodyInput = screen.getByTestId("signature-new-body");
    fireEvent.change(labelInput, { target: { value: "Demo" } });
    fireEvent.change(bodyInput, { target: { value: "Cheers,\nNick" } });
    fireEvent.click(screen.getByTestId("signature-new-default"));
    fireEvent.click(screen.getByTestId("signature-create-btn"));
    await flushPromises();

    const calls = mockFetchWithRefresh.mock.calls;
    const post = calls.find(
      (c) => c[0] === "/api/email-signatures" && c[1]?.method === "POST",
    );
    expect(post).toBeDefined();
    const body = JSON.parse(post![1].body as string);
    expect(body.label).toBe("Demo");
    expect(body.body).toBe("Cheers,\nNick");
    expect(body.isDefault).toBe(true);
  });

  it("validates label/body before posting", async () => {
    render(<SettingsPage />);
    await flushPromises();
    fireEvent.click(await screen.findByTestId("signature-create-btn"));
    await flushPromises();
    expect(screen.getByRole("alert").textContent).toMatch(
      /Label and body are required/i,
    );
    /* Should not have called POST. */
    const posts = mockFetchWithRefresh.mock.calls.filter(
      (c) => c[1]?.method === "POST" && c[0] === "/api/email-signatures",
    );
    expect(posts).toHaveLength(0);
  });

  it("PATCHes a signature when 'Set as default' is clicked", async () => {
    render(<SettingsPage />);
    await flushPromises();

    fireEvent.click(await screen.findByTestId("signature-set-default-sig-2"));
    await flushPromises();

    const calls = mockFetchWithRefresh.mock.calls;
    const patch = calls.find(
      (c) =>
        typeof c[0] === "string" &&
        c[0].startsWith("/api/email-signatures/sig-2") &&
        c[1]?.method === "PATCH",
    );
    expect(patch).toBeDefined();
    expect(JSON.parse(patch![1].body as string)).toEqual({ isDefault: true });
  });

  it("DELETEs a signature when Delete is clicked", async () => {
    render(<SettingsPage />);
    await flushPromises();

    fireEvent.click(await screen.findByTestId("signature-delete-sig-2"));
    await flushPromises();

    const calls = mockFetchWithRefresh.mock.calls;
    const del = calls.find(
      (c) =>
        typeof c[0] === "string" &&
        c[0].startsWith("/api/email-signatures/sig-2") &&
        c[1]?.method === "DELETE",
    );
    expect(del).toBeDefined();
  });

  it("Edit → Save sends a PATCH with new label and body", async () => {
    render(<SettingsPage />);
    await flushPromises();

    fireEvent.click(await screen.findByTestId("signature-edit-sig-1"));
    const labelEdit = await screen.findByTestId("signature-edit-label-sig-1");
    fireEvent.change(labelEdit, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByTestId("signature-save-sig-1"));
    await flushPromises();

    const calls = mockFetchWithRefresh.mock.calls;
    const patch = calls.find(
      (c) =>
        typeof c[0] === "string" &&
        c[0].startsWith("/api/email-signatures/sig-1") &&
        c[1]?.method === "PATCH",
    );
    expect(patch).toBeDefined();
    const body = JSON.parse(patch![1].body as string);
    expect(body.label).toBe("Renamed");
  });

  it("shows empty state when the API returns an empty list", async () => {
    mockFetchWithRefresh.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/email-signatures") && (!init || !init.method)) {
        return Promise.resolve(ok({ signatures: [] }));
      }
      return Promise.resolve(defaultRouter(url, init));
    });
    render(<SettingsPage />);
    await waitFor(() =>
      expect(screen.getByText(/No signatures yet/i)).toBeInTheDocument(),
    );
  });
});
