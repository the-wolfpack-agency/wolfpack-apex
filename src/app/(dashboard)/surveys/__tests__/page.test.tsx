/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * /surveys page UI tests.
 *
 * This RTL suite is the top test layer for the survey builder (apex has
 * no Playwright), so it exercises the full render → action → state paths.
 *
 * Locks:
 *   - Redirects (renders only the loading skeleton) when no token present
 *   - Renders existing surveys from the initial GET /api/surveys
 *   - The create form's question builder assembles a schema with stable
 *     ids + types and POSTs it; the new survey is prepended to the list
 *   - Publish toggles status via PATCH and updates the row in place
 *   - Delete confirms, DELETEs, and removes the row
 *   - Generate QR POSTs to :id/qr and shows the linked indicator
 *   - View results GETs :id/responses and renders count + aggregate
 */

const mockFetchWithRefresh = jest.fn();
const mockGetInstinctToken = jest.fn();

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  jsonHeaders: () => ({
    "Content-Type": "application/json",
    Authorization: "Bearer x",
  }),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  getInstinctToken: (...a: any[]) => mockGetInstinctToken(...a),
}));

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import SurveysPage from "@/app/(dashboard)/surveys/page";

/* ----------------------------- fixtures ----------------------------- */

const sampleSurvey = {
  id: "survey-1",
  slug: "abc1234",
  title: "Post-event feedback",
  description: "How did we do?",
  schema: {
    questions: [
      { id: "q1", type: "rating", label: "Rate us", required: true, max: 5 },
      {
        id: "q2",
        type: "single_choice",
        label: "Come again?",
        required: false,
        options: ["Yes", "No"],
      },
    ],
  },
  status: "draft",
  qrCodeId: null,
  clientId: null,
  createdByUserId: "u1",
  createdByUserRole: "ceo",
  createdAt: "2026-06-01T10:00:00.000Z",
  updatedAt: "2026-06-01T10:00:00.000Z",
};

const sampleSurvey2 = {
  ...sampleSurvey,
  id: "survey-2",
  slug: "xyz9876",
  title: "NPS pulse",
  status: "published",
};

/* ----------------------------- helpers ------------------------------ */

function mockListResponse(surveys: unknown[]) {
  /* The first call after mount is GET /api/surveys. */
  mockFetchWithRefresh.mockImplementationOnce(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ surveys }),
    }),
  );
}

function findUrlArg(call: any[]): string {
  const arg = call[0];
  return typeof arg === "string" ? arg : String(arg);
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockGetInstinctToken.mockReset();
  mockGetInstinctToken.mockReturnValue("tok");
});

/* ------------------------------ tests ------------------------------- */

describe("/surveys page", () => {
  test("does not render the main UI and consults getInstinctToken when no token is present (redirect path)", async () => {
    mockGetInstinctToken.mockReturnValue(null);

    render(<SurveysPage />);

    await waitFor(() => {
      expect(mockGetInstinctToken).toHaveBeenCalled();
    });

    /* Page never advances past loading — the redirect path returns
       before authChecked is set. */
    expect(screen.getByTestId("surveys-page-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("surveys-page")).toBeNull();
    expect(screen.queryByTestId("survey-create-form")).toBeNull();

    /* No authed endpoint was hit. */
    const apiCalls = mockFetchWithRefresh.mock.calls.filter((c) =>
      String(c[0]).startsWith("/api/surveys"),
    );
    expect(apiCalls).toHaveLength(0);
  });

  test("renders existing surveys from GET /api/surveys", async () => {
    mockListResponse([sampleSurvey, sampleSurvey2]);

    render(<SurveysPage />);

    await waitFor(() =>
      expect(screen.getByTestId("survey-create-form")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("survey-create-title")).toBeInTheDocument();
    expect(screen.getByTestId("survey-add-question")).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByTestId("survey-row-survey-1")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("survey-row-survey-2")).toBeInTheDocument();
    /* Public link + status surface. */
    expect(screen.getByTestId("survey-row-link-survey-1")).toHaveTextContent(
      "/s/abc1234",
    );
    expect(screen.getByTestId("survey-row-status-survey-2")).toHaveTextContent(
      "published",
    );
  });

  test("renders empty state when GET /api/surveys returns []", async () => {
    mockListResponse([]);

    render(<SurveysPage />);

    await waitFor(() =>
      expect(screen.getByTestId("surveys-empty")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("surveys-list")).toBeNull();
    /* The create form is still present alongside the empty state. */
    expect(
      within(screen.getByTestId("survey-create-section")).getByTestId(
        "survey-create-form",
      ),
    ).toBeInTheDocument();
  });

  test("create form builds a schema (ids/types) and POSTs the assembled body, then prepends the row", async () => {
    mockListResponse([sampleSurvey2]);

    const newSurvey = {
      ...sampleSurvey,
      id: "survey-3",
      slug: "new5678",
      title: "Quick poll",
      status: "draft",
    };
    /* Second call: the POST → 201. */
    mockFetchWithRefresh.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({ survey: newSurvey }),
      }),
    );

    render(<SurveysPage />);
    await waitFor(() =>
      expect(screen.getByTestId("survey-create-form")).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByTestId("survey-create-title"), {
      target: { value: "Quick poll" },
    });

    /* Add two questions: a short_text and a single_choice with options. */
    fireEvent.click(screen.getByTestId("survey-add-question"));
    fireEvent.click(screen.getByTestId("survey-add-question"));

    fireEvent.change(screen.getByTestId("survey-q-label-0"), {
      target: { value: "Your name" },
    });
    /* q0 stays short_text (default). Mark it required. */
    fireEvent.click(screen.getByTestId("survey-q-required-0"));

    fireEvent.change(screen.getByTestId("survey-q-label-1"), {
      target: { value: "Pick one" },
    });
    fireEvent.change(screen.getByTestId("survey-q-type-1"), {
      target: { value: "single_choice" },
    });
    /* Options input appears once the type is a choice type. */
    fireEvent.change(screen.getByTestId("survey-q-options-1"), {
      target: { value: " Red, Green , Blue " },
    });

    fireEvent.click(screen.getByTestId("survey-create-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("survey-row-survey-3")).toBeInTheDocument(),
    );

    /* Inspect the POST. */
    const postCall = mockFetchWithRefresh.mock.calls.find(
      (c) => c[1]?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    expect(findUrlArg(postCall!)).toBe("/api/surveys");
    const body = JSON.parse(postCall![1].body);
    expect(body.title).toBe("Quick poll");
    expect(Array.isArray(body.schema.questions)).toBe(true);
    expect(body.schema.questions).toHaveLength(2);

    const [qa, qb] = body.schema.questions;
    expect(qa.id).toBe("q1");
    expect(qa.type).toBe("short_text");
    expect(qa.label).toBe("Your name");
    expect(qa.required).toBe(true);
    /* short_text carries no options. */
    expect(qa.options).toBeUndefined();

    expect(qb.id).toBe("q2");
    expect(qb.type).toBe("single_choice");
    expect(qb.label).toBe("Pick one");
    /* Options parsed by splitting on commas + trimming. */
    expect(qb.options).toEqual(["Red", "Green", "Blue"]);

    /* New survey prepended; the pre-existing one stays. */
    expect(screen.getByTestId("survey-row-survey-2")).toBeInTheDocument();
  });

  test("publish toggles status via PATCH and updates the row in place", async () => {
    mockListResponse([sampleSurvey]); // status: draft
    mockFetchWithRefresh.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          survey: { ...sampleSurvey, status: "published" },
        }),
      }),
    );

    render(<SurveysPage />);
    await waitFor(() =>
      expect(screen.getByTestId("survey-row-survey-1")).toBeInTheDocument(),
    );

    expect(screen.getByTestId("survey-row-status-survey-1")).toHaveTextContent(
      "draft",
    );
    expect(screen.getByTestId("survey-publish-survey-1")).toHaveTextContent(
      "Publish",
    );

    fireEvent.click(screen.getByTestId("survey-publish-survey-1"));

    await waitFor(() => {
      const patchCall = mockFetchWithRefresh.mock.calls.find(
        (c) => c[1]?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      expect(findUrlArg(patchCall!)).toContain(
        `/api/surveys/${encodeURIComponent("survey-1")}`,
      );
      expect(JSON.parse(patchCall![1].body)).toEqual({ status: "published" });
    });

    /* Row reflects the published status + button flips to Close. */
    await waitFor(() =>
      expect(
        screen.getByTestId("survey-row-status-survey-1"),
      ).toHaveTextContent("published"),
    );
    expect(screen.getByTestId("survey-publish-survey-1")).toHaveTextContent(
      "Close",
    );
  });

  test("delete confirms then DELETEs and removes the row", async () => {
    mockListResponse([sampleSurvey, sampleSurvey2]);
    mockFetchWithRefresh.mockImplementationOnce(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    );

    const confirmSpy = jest
      .spyOn(window, "confirm")
      .mockImplementation(() => true);

    render(<SurveysPage />);
    await waitFor(() =>
      expect(screen.getByTestId("survey-row-survey-1")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("survey-delete-survey-1"));

    await waitFor(() => {
      const deleteCall = mockFetchWithRefresh.mock.calls.find(
        (c) => c[1]?.method === "DELETE",
      );
      expect(deleteCall).toBeTruthy();
      expect(findUrlArg(deleteCall!)).toContain(
        `/api/surveys/${encodeURIComponent("survey-1")}`,
      );
    });
    expect(confirmSpy).toHaveBeenCalled();

    await waitFor(() =>
      expect(screen.queryByTestId("survey-row-survey-1")).toBeNull(),
    );
    expect(screen.getByTestId("survey-row-survey-2")).toBeInTheDocument();

    confirmSpy.mockRestore();
  });

  test("delete does NOT fire when confirm is dismissed", async () => {
    mockListResponse([sampleSurvey]);

    const confirmSpy = jest
      .spyOn(window, "confirm")
      .mockImplementation(() => false);

    render(<SurveysPage />);
    await waitFor(() =>
      expect(screen.getByTestId("survey-row-survey-1")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("survey-delete-survey-1"));

    const deleteCalls = mockFetchWithRefresh.mock.calls.filter(
      (c) => c[1]?.method === "DELETE",
    );
    expect(deleteCalls).toHaveLength(0);
    expect(screen.getByTestId("survey-row-survey-1")).toBeInTheDocument();

    confirmSpy.mockRestore();
  });

  test("generate QR POSTs to :id/qr and shows the linked indicator", async () => {
    mockListResponse([sampleSurvey]); // qrCodeId: null
    mockFetchWithRefresh.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          code: { id: "qr-1", slug: "qrslug" },
          survey: { ...sampleSurvey, qrCodeId: "qr-1" },
        }),
      }),
    );

    render(<SurveysPage />);
    await waitFor(() =>
      expect(screen.getByTestId("survey-row-survey-1")).toBeInTheDocument(),
    );

    /* Not linked yet. */
    expect(screen.queryByTestId("survey-row-qr-linked-survey-1")).toBeNull();

    fireEvent.click(screen.getByTestId("survey-qr-survey-1"));

    await waitFor(() => {
      const qrCall = mockFetchWithRefresh.mock.calls.find(
        (c) =>
          c[1]?.method === "POST" &&
          findUrlArg(c).includes(
            `/api/surveys/${encodeURIComponent("survey-1")}/qr`,
          ),
      );
      expect(qrCall).toBeTruthy();
    });

    /* Linked indicator now renders. */
    await waitFor(() =>
      expect(
        screen.getByTestId("survey-row-qr-linked-survey-1"),
      ).toBeInTheDocument(),
    );
  });

  test("view results GETs :id/responses and renders count + per-question aggregate", async () => {
    mockListResponse([sampleSurvey]);
    mockFetchWithRefresh.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          count: 7,
          aggregate: [
            { questionId: "q1", label: "Rate us", type: "rating", average: 4.2, total: 7 },
            {
              questionId: "q2",
              label: "Come again?",
              type: "single_choice",
              counts: { Yes: 5, No: 2 },
              total: 7,
            },
          ],
          responses: [],
        }),
      }),
    );

    render(<SurveysPage />);
    await waitFor(() =>
      expect(screen.getByTestId("survey-row-survey-1")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("survey-results-survey-1"));

    await waitFor(() => {
      const respCall = mockFetchWithRefresh.mock.calls.find((c) =>
        findUrlArg(c).includes(
          `/api/surveys/${encodeURIComponent("survey-1")}/responses`,
        ),
      );
      expect(respCall).toBeTruthy();
    });

    await waitFor(() =>
      expect(
        screen.getByTestId("survey-results-panel-survey-1"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByTestId("survey-results-count-survey-1")).toHaveTextContent(
      "7 responses",
    );
    /* Both per-question aggregate blocks rendered. */
    expect(
      screen.getByTestId("survey-results-q-survey-1-0"),
    ).toHaveTextContent("Rate us");
    expect(
      screen.getByTestId("survey-results-q-survey-1-1"),
    ).toHaveTextContent("Come again?");
    /* Choice counts surfaced. */
    expect(
      screen.getByTestId("survey-results-q-survey-1-1"),
    ).toHaveTextContent("Yes");

    /* Toggle again hides the panel. */
    fireEvent.click(screen.getByTestId("survey-results-survey-1"));
    await waitFor(() =>
      expect(
        screen.queryByTestId("survey-results-panel-survey-1"),
      ).toBeNull(),
    );
  });
});
