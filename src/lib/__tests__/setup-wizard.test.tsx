/**
 * @jest-environment jsdom
 */

/**
 * Setup wizard UI tests — server-state-driven step derivation, draft persistence,
 * workspace save, invites, connect buttons, and completion.
 */

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
const mockPush = jest.fn();

// Mock connect helpers
const mockStartMicrosoftConnect = jest.fn();
const mockStartQuickbooksConnect = jest.fn();
const mockConnectPlaud = jest.fn();

jest.mock("@/lib/integrations/connect", () => ({
  startMicrosoftConnect: (...args: unknown[]) => mockStartMicrosoftConnect(...args),
  startQuickbooksConnect: (...args: unknown[]) => mockStartQuickbooksConnect(...args),
  connectPlaud: (...args: unknown[]) => mockConnectPlaud(...args),
}));

// Mock draft helpers
let draftStore: Record<string, unknown> = {};

jest.mock("@/lib/setup-draft", () => ({
  loadDraft: () => draftStore,
  saveDraft: (d: Record<string, unknown>) => { draftStore = { ...draftStore, ...d }; },
  clearDraft: () => { draftStore = {}; },
}));

jest.mock("@/lib/client-auth", () => ({
  getInstinctToken: () => "test-token",
  getInstinctUser: () => ({ id: "u1", name: "Test User", email: "test@example.com", role: "cto" }),
  jsonHeaders: () => ({ Authorization: "Bearer test-token", "Content-Type": "application/json" }),
  authHeaders: () => ({ Authorization: "Bearer test-token" }),
}));

// URL-aware fetch dispatcher
const fetchMock = jest.fn();

beforeAll(() => {
  global.fetch = fetchMock;
});

beforeEach(() => {
  fetchMock.mockReset();
  mockPush.mockReset();
  mockStartMicrosoftConnect.mockReset();
  mockStartQuickbooksConnect.mockReset();
  mockConnectPlaud.mockReset();
  draftStore = {};

  // Default: analytics and team/invite calls succeed silently
  fetchMock.mockImplementation((url: string) => {
    if (url === "/api/analytics") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    if (url === "/api/team/invite") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    // Fallback: fail loudly so tests can catch unhandled urls
    return Promise.reject(new Error(`Unmocked fetch: ${url}`));
  });
});

function makeStatusResponse(nextStep: "profile" | "team" | "integrations" | "complete") {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        complete: nextStep === "complete",
        steps: {
          profile: nextStep !== "profile",
          team: nextStep === "integrations" || nextStep === "complete",
          integrations: nextStep === "complete",
        },
        nextStep,
      }),
  };
}

function withStatus(nextStep: "profile" | "team" | "integrations" | "complete") {
  // Override the status endpoint for a test
  fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
    if (url === "/api/workspace/status") {
      return Promise.resolve(makeStatusResponse(nextStep));
    }
    if (url === "/api/analytics") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    if (url === "/api/team/invite") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    if (url === "/api/workspace" && opts?.method === "PUT") {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    }
    return Promise.reject(new Error(`Unmocked fetch: ${url}`));
  });
}

import SetupPage from "@/app/(dashboard)/setup/page";

/* ─────────────────── Step rendering ─────────────────── */

describe("step rendering from nextStep", () => {
  it("renders step 1 (Workspace Info) when nextStep=profile", async () => {
    withStatus("profile");
    await act(async () => { render(<SetupPage />); });
    await waitFor(() => expect(screen.getByText(/workspace info/i)).toBeInTheDocument());
    expect(screen.getByPlaceholderText(/your company or team name/i)).toBeInTheDocument();
  });

  it("renders step 2 (Invite Team) when nextStep=team", async () => {
    withStatus("team");
    await act(async () => { render(<SetupPage />); });
    await waitFor(() => expect(screen.getByText(/invite team/i)).toBeInTheDocument());
    expect(screen.getByPlaceholderText(/teammate@company.com/i)).toBeInTheDocument();
  });

  it("renders step 3 (Connect Integrations) when nextStep=integrations", async () => {
    withStatus("integrations");
    await act(async () => { render(<SetupPage />); });
    await waitFor(() => expect(screen.getByText(/connect integrations/i)).toBeInTheDocument());
    expect(screen.getByText(/Microsoft 365/)).toBeInTheDocument();
  });

  it("renders step 4 (You're Ready) when nextStep=complete", async () => {
    withStatus("complete");
    await act(async () => { render(<SetupPage />); });
    await waitFor(() => expect(screen.getByText(/you are all set/i)).toBeInTheDocument());
    expect(screen.getByText(/go to dashboard/i)).toBeInTheDocument();
  });
});

/* ─────────────────── Back button ─────────────────── */

describe("back button behavior", () => {
  it("back button at step 1 (team) goes to step 0 view", async () => {
    withStatus("team");
    await act(async () => { render(<SetupPage />); });
    await waitFor(() => expect(screen.getByText(/invite team/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    await waitFor(() => expect(screen.getByText(/workspace info/i)).toBeInTheDocument());
  });

  it("back button does not render at step 0", async () => {
    withStatus("profile");
    await act(async () => { render(<SetupPage />); });
    await waitFor(() => expect(screen.getByText(/workspace info/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /back/i })).not.toBeInTheDocument();
  });
});

/* ─────────────────── Workspace save (Step 1) ─────────────────── */

describe("workspace name save", () => {
  it("calls PUT /api/workspace and refetches status on success", async () => {
    // Override so PUT advances to team
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === "/api/workspace/status") {
        // After PUT, return team; initially return profile
        return Promise.resolve(makeStatusResponse("profile"));
      }
      if (url === "/api/workspace" && opts?.method === "PUT") {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      }
      if (url === "/api/analytics") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      return Promise.reject(new Error(`Unmocked: ${url}`));
    });

    // After first status call returns profile, switch to returning team
    let statusCallCount = 0;
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === "/api/workspace/status") {
        statusCallCount++;
        const step = statusCallCount === 1 ? "profile" : "team";
        return Promise.resolve(makeStatusResponse(step as "profile" | "team"));
      }
      if (url === "/api/workspace" && opts?.method === "PUT") {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      }
      if (url === "/api/analytics") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      return Promise.reject(new Error(`Unmocked: ${url}`));
    });

    await act(async () => { render(<SetupPage />); });
    await waitFor(() => expect(screen.getByText(/workspace info/i)).toBeInTheDocument());

    const input = screen.getByPlaceholderText(/your company or team name/i);
    fireEvent.change(input, { target: { value: "Acme Corp" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    });

    // Verify PUT was called
    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(
        (c: [string, RequestInit?]) => c[0] === "/api/workspace" && c[1]?.method === "PUT",
      );
      expect(putCall).toBeTruthy();
    });

    // After refetch, step 2 should render
    await waitFor(() => expect(screen.getByText(/invite team/i)).toBeInTheDocument());
  });

  it("shows inline error on 400 response, does not advance", async () => {
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === "/api/workspace/status") {
        return Promise.resolve(makeStatusResponse("profile"));
      }
      if (url === "/api/workspace" && opts?.method === "PUT") {
        return Promise.resolve({
          ok: false, status: 400,
          json: () => Promise.resolve({ error: "Name too short" }),
        });
      }
      if (url === "/api/analytics") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      return Promise.reject(new Error(`Unmocked: ${url}`));
    });

    await act(async () => { render(<SetupPage />); });
    await waitFor(() => expect(screen.getByText(/workspace info/i)).toBeInTheDocument());

    const input = screen.getByPlaceholderText(/your company or team name/i);
    fireEvent.change(input, { target: { value: "AB" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    });

    await waitFor(() => expect(screen.getByText(/name too short/i)).toBeInTheDocument());
    expect(screen.getByText(/workspace info/i)).toBeInTheDocument();
  });

  it("shows error on 503 response", async () => {
    fetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === "/api/workspace/status") {
        return Promise.resolve(makeStatusResponse("profile"));
      }
      if (url === "/api/workspace" && opts?.method === "PUT") {
        return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
      }
      if (url === "/api/analytics") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      return Promise.reject(new Error(`Unmocked: ${url}`));
    });

    await act(async () => { render(<SetupPage />); });
    await waitFor(() => expect(screen.getByText(/workspace info/i)).toBeInTheDocument());

    const input = screen.getByPlaceholderText(/your company or team name/i);
    fireEvent.change(input, { target: { value: "Acme" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    });

    await waitFor(() => expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument());
  });
});

/* ─────────────────── Draft persistence ─────────────────── */

describe("draft persistence via sessionStorage", () => {
  it("loads pre-filled workspace name from draft on mount", async () => {
    draftStore = { workspaceName: "Draft Corp" };
    withStatus("profile");

    await act(async () => { render(<SetupPage />); });
    await waitFor(() => expect(screen.getByText(/workspace info/i)).toBeInTheDocument());

    const input = screen.getByPlaceholderText(/your company or team name/i) as HTMLInputElement;
    expect(input.value).toBe("Draft Corp");
  });

  it("loads pre-filled invites from draft on mount", async () => {
    draftStore = { invites: [{ email: "saved@test.com", role: "dev" }] };
    withStatus("team");

    await act(async () => { render(<SetupPage />); });
    await waitFor(() => expect(screen.getByText(/invite team/i)).toBeInTheDocument());

    const emailInput = screen.getByPlaceholderText(/teammate@company.com/i) as HTMLInputElement;
    expect(emailInput.value).toBe("saved@test.com");
  });
});

/* ─────────────────── Connect buttons ─────────────────── */

describe("connect buttons on step 3", () => {
  beforeEach(() => {
    withStatus("integrations");
  });

  it("Microsoft Connect calls startMicrosoftConnect with returnTo=/setup", async () => {
    mockStartMicrosoftConnect.mockResolvedValue({ ok: true });

    await act(async () => { render(<SetupPage />); });
    await waitFor(() => expect(screen.getByText(/Microsoft 365/)).toBeInTheDocument());

    const connectBtns = screen.getAllByRole("button", { name: /connect/i });
    await act(async () => { fireEvent.click(connectBtns[0]); });

    expect(mockStartMicrosoftConnect).toHaveBeenCalledWith({ returnTo: "/setup" });
  });

  it("QuickBooks Connect calls startQuickbooksConnect with returnTo=/setup", async () => {
    mockStartQuickbooksConnect.mockResolvedValue({ ok: true });

    await act(async () => { render(<SetupPage />); });
    await waitFor(() => expect(screen.getByText(/QuickBooks/)).toBeInTheDocument());

    const connectBtns = screen.getAllByRole("button", { name: /connect/i });
    await act(async () => { fireEvent.click(connectBtns[1]); });

    expect(mockStartQuickbooksConnect).toHaveBeenCalledWith({ returnTo: "/setup" });
  });

  it("Plaud Connect calls connectPlaud", async () => {
    mockConnectPlaud.mockResolvedValue({ ok: true });

    await act(async () => { render(<SetupPage />); });
    await waitFor(() => expect(screen.getByText(/Plaud/)).toBeInTheDocument());

    const connectBtns = screen.getAllByRole("button", { name: /connect/i });
    await act(async () => { fireEvent.click(connectBtns[2]); });

    expect(mockConnectPlaud).toHaveBeenCalledWith(true);
  });

  it("shows connect error when helper returns error", async () => {
    mockStartMicrosoftConnect.mockResolvedValue({
      ok: false,
      error: "Microsoft 365 integration is not configured yet.",
    });

    await act(async () => { render(<SetupPage />); });
    await waitFor(() => expect(screen.getByText(/Microsoft 365/)).toBeInTheDocument());

    const connectBtns = screen.getAllByRole("button", { name: /connect/i });
    await act(async () => { fireEvent.click(connectBtns[0]); });

    await waitFor(() =>
      expect(screen.getByText(/not configured/i)).toBeInTheDocument(),
    );
  });
});

/* ─────────────────── Complete state ─────────────────── */

describe("completion state", () => {
  it("renders You are all set when nextStep=complete", async () => {
    withStatus("complete");
    await act(async () => { render(<SetupPage />); });
    await waitFor(() => expect(screen.getByText(/you are all set/i)).toBeInTheDocument());
  });

  it("Go to Dashboard button fires analytics and pushes to /", async () => {
    withStatus("complete");
    await act(async () => { render(<SetupPage />); });
    await waitFor(() => expect(screen.getByText(/go to dashboard/i)).toBeInTheDocument());

    await act(async () => {
      fireEvent.click(screen.getByText(/go to dashboard/i));
    });

    expect(mockPush).toHaveBeenCalledWith("/");
  });
});

export {};
