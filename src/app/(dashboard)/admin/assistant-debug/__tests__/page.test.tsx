/**
 * @jest-environment jsdom
 *
 * /admin/assistant-debug — UI rendering tests.
 *
 * Covers:
 *   - On mount, calls /api/assistant/grounding-debug?q=<default>.
 *   - Renders all 5 diagnostic sections from the response.
 *   - Renders OK/MISSING scope rows with colors.
 *   - Custom-question form re-fetches with the new q.
 *   - Surfaces probe failures in the table.
 *   - Surfaces the diagnosis paragraph verbatim.
 */
 

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
}));

import AssistantDebugPage from "../page";

function buildResponse(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    question: "What's in the TWA Agenda 4.20 doc?",
    user: {
      id_hint: "u-572d80",
      name: "Nick Homyk",
      email: "homyk@thewolfpack.agency",
      role: "ceo",
    },
    token: {
      has_token: true,
      decodable: true,
      user_email: "homyk@thewolfpack.agency",
      expires_at: "2026-04-30T14:00:00.000Z",
      expires_in_seconds: 27 * 60,
      audience: "https://graph.microsoft.com",
      tenant_id: "tnt-1",
      upn: "homyk@thewolfpack.agency",
      scopes: {
        scopes_in_token: ["User.Read", "Mail.Read", "Calendars.Read"],
        expected_present: ["User.Read", "Mail.Read", "Calendars.Read"],
        expected_missing: ["Sites.Read.All", "Tasks.Read"],
        has_all_expected: false,
      },
    },
    probes: [
      {
        name: "user_profile",
        label: "User profile",
        endpoint: "/me",
        method: "GET",
        status: 200,
        ok: true,
        count: 1,
        scope_missing: false,
        took_ms: 80,
      },
      {
        name: "sharepoint_search_query",
        label: "SharePoint /search/query",
        endpoint: "/search/query",
        method: "POST",
        status: 403,
        ok: false,
        scope_missing: true,
        error_code: "AccessDenied",
        error_message: "Insufficient privileges",
        took_ms: 60,
      },
    ],
    bundle: {
      surface: "assistant_support",
      total_chars: 0,
      took_ms: 5,
      sharepoint_hits_count: 0,
      project_tasks_count: 0,
      meeting_notes_count: 0,
      failures_observed: [
        {
          source: "sharepoint",
          status: 403,
          scope_missing: true,
          code: "scope_missing",
          message: "no Sites.Read.All",
        },
      ],
      rendered_prompt_block: "",
    },
    diagnosis:
      "Your delegated token is missing required scopes: Sites.Read.All, Tasks.Read.",
    generated_at: "2026-04-29T10:00:00.000Z",
    ...overrides,
  };
}

function fakeRes(body: unknown, status = 200): Response {
  // Hand-rolled minimal Response since jsdom env doesn't expose one in
  // ts-jest's default lib config. Mirrors the shape the component reads
  // (ok / status / json()).
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () =>
      typeof body === "string" ? body : JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchWithRefresh.mockImplementation(async () => fakeRes(buildResponse()));
});

describe("AssistantDebugPage", () => {
  it("loads diagnostic on mount with the default question", async () => {
    await act(async () => {
      render(<AssistantDebugPage />);
    });
    await waitFor(() =>
      expect(mockFetchWithRefresh).toHaveBeenCalledWith(
        "/api/assistant/grounding-debug?q=What's%20in%20the%20TWA%20Agenda%204.20%20doc%3F",
      ),
    );
  });

  it("renders all five diagnostic sections", async () => {
    await act(async () => {
      render(<AssistantDebugPage />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("section-user")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("section-token")).toBeInTheDocument();
    expect(screen.getByTestId("section-probes")).toBeInTheDocument();
    expect(screen.getByTestId("section-bundle")).toBeInTheDocument();
    expect(screen.getByTestId("section-diagnosis")).toBeInTheDocument();
  });

  it("renders signed-in-as block", async () => {
    await act(async () => {
      render(<AssistantDebugPage />);
    });
    await waitFor(() =>
      expect(screen.getByText(/Nick Homyk/)).toBeInTheDocument(),
    );
    expect(screen.getAllByText(/homyk@thewolfpack\.agency/).length).toBeGreaterThan(0);
  });

  it("renders missing scopes with explicit MISSING marker", async () => {
    await act(async () => {
      render(<AssistantDebugPage />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("section-scopes")).toBeInTheDocument(),
    );
    const scopes = screen.getByTestId("section-scopes");
    expect(scopes.textContent).toContain("Sites.Read.All");
    expect(scopes.textContent).toContain("MISSING");
  });

  it("surfaces a probe failure row with scope_missing flag", async () => {
    await act(async () => {
      render(<AssistantDebugPage />);
    });
    await waitFor(() =>
      expect(
        screen.getByTestId("probe-row-sharepoint_search_query"),
      ).toBeInTheDocument(),
    );
    const row = screen.getByTestId("probe-row-sharepoint_search_query");
    expect(row.textContent).toContain("403");
    expect(row.textContent).toContain("scope_missing=true");
  });

  it("renders the diagnosis paragraph verbatim", async () => {
    await act(async () => {
      render(<AssistantDebugPage />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("diagnosis-text")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("diagnosis-text").textContent).toContain(
      "Sites.Read.All",
    );
  });

  it("re-runs with custom question when form is submitted", async () => {
    await act(async () => {
      render(<AssistantDebugPage />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("section-user")).toBeInTheDocument(),
    );
    mockFetchWithRefresh.mockClear();
    const input = screen.getByTestId("assistant-debug-question-input");
    fireEvent.change(input, { target: { value: "where is foo.docx" } });
    const button = screen.getByTestId("assistant-debug-run-button");
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() =>
      expect(mockFetchWithRefresh).toHaveBeenCalledWith(
        "/api/assistant/grounding-debug?q=where%20is%20foo.docx",
      ),
    );
  });

  it("surfaces a fetch error", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(fakeRes("nope", 500));
    await act(async () => {
      render(<AssistantDebugPage />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("assistant-debug-error")).toBeInTheDocument(),
    );
  });

  it("renders no_token diagnosis when token is missing", async () => {
    mockFetchWithRefresh.mockResolvedValueOnce(
      fakeRes(
        buildResponse({
          token: {
            has_token: false,
            decodable: false,
            user_email: null,
            expires_at: null,
            expires_in_seconds: null,
            audience: null,
            tenant_id: null,
            upn: null,
            scopes: null,
          },
          probes: [],
          diagnosis:
            "No Microsoft 365 token is stored for your account. Connect Microsoft from Settings.",
        }),
      ),
    );
    await act(async () => {
      render(<AssistantDebugPage />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("diagnosis-text")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("diagnosis-text").textContent).toMatch(
      /No Microsoft 365 token/,
    );
  });
});
