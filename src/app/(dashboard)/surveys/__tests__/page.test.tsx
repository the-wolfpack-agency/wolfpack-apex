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
 *   - View results GETs :id/insights and renders the funnel (views,
 *     responses, completion %, avg time) + per-question breakdown
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
  qrCodeId: "qr-2", // linked → exercises the inline "Show QR" panel
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

  test("'Add section' adds a section row (labeled Section, type=section)", async () => {
    mockListResponse([]);
    render(<SurveysPage />);
    await waitFor(() =>
      expect(screen.getByTestId("survey-create-form")).toBeInTheDocument(),
    );

    expect(screen.getByTestId("survey-add-section")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("survey-add-section"));

    // The new row is pre-set to the section type and labeled "Section".
    const typeSelect = screen.getByTestId("survey-q-type-0") as HTMLSelectElement;
    expect(typeSelect.value).toBe("section");
    const row = screen.getByTestId("survey-question-row-0");
    expect(within(row).getByText(/^Section 1$/)).toBeInTheDocument();
    // Sections expose a body field, not a required toggle.
    expect(screen.getByTestId("survey-q-body-0")).toBeInTheDocument();
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

  test("builds a 'Weekend with Porsche'-shaped survey exercising section/allowOther/maxSelections/email/visibleIf and POSTs the right schema", async () => {
    mockListResponse([]);

    const newSurvey = {
      ...sampleSurvey,
      id: "survey-9",
      slug: "porsch1",
      title: "A Weekend with Porsche",
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
      target: { value: "A Weekend with Porsche" },
    });

    /* Five questions:
       q1 = section (intro), q2 = single_choice + allowOther,
       q3 = multiple_choice + maxSelections 3, q4 = email,
       q5 = conditional (visibleIf q2 equals "Yes"). */
    for (let i = 0; i < 5; i += 1) {
      fireEvent.click(screen.getByTestId("survey-add-question"));
    }

    /* q1: section. */
    fireEvent.change(screen.getByTestId("survey-q-type-0"), {
      target: { value: "section" },
    });
    fireEvent.change(screen.getByTestId("survey-q-label-0"), {
      target: { value: "Shape the Cayenne Experience" },
    });
    fireEvent.change(screen.getByTestId("survey-q-body-0"), {
      target: { value: "Your feedback shapes the final experience." },
    });
    /* Sections expose no required checkbox. */
    expect(screen.queryByTestId("survey-q-required-0")).toBeNull();

    /* q2: single_choice with allowOther. */
    fireEvent.change(screen.getByTestId("survey-q-type-1"), {
      target: { value: "single_choice" },
    });
    fireEvent.change(screen.getByTestId("survey-q-label-1"), {
      target: { value: "Are you interested in the pilot?" },
    });
    fireEvent.change(screen.getByTestId("survey-q-help-1"), {
      target: { value: "Select one" },
    });
    fireEvent.change(screen.getByTestId("survey-q-options-1"), {
      target: { value: "Yes, More info, No" },
    });
    fireEvent.click(screen.getByTestId("survey-q-allowother-1"));
    fireEvent.click(screen.getByTestId("survey-q-required-1"));

    /* q3: multiple_choice with maxSelections=3. */
    fireEvent.change(screen.getByTestId("survey-q-type-2"), {
      target: { value: "multiple_choice" },
    });
    fireEvent.change(screen.getByTestId("survey-q-label-2"), {
      target: { value: "Which resources help most?" },
    });
    fireEvent.change(screen.getByTestId("survey-q-options-2"), {
      target: { value: "Templates, Guides, Playbook, Tools" },
    });
    fireEvent.change(screen.getByTestId("survey-q-maxselections-2"), {
      target: { value: "3" },
    });

    /* q4: email. */
    fireEvent.change(screen.getByTestId("survey-q-type-3"), {
      target: { value: "email" },
    });
    fireEvent.change(screen.getByTestId("survey-q-label-3"), {
      target: { value: "Email" },
    });

    /* q5: short_text shown only when q2 === "Yes". */
    fireEvent.change(screen.getByTestId("survey-q-label-4"), {
      target: { value: "Porsche Center" },
    });
    fireEvent.change(screen.getByTestId("survey-q-visibleif-q-4"), {
      target: { value: "q2" },
    });
    fireEvent.change(screen.getByTestId("survey-q-visibleif-val-4"), {
      target: { value: "Yes" },
    });

    fireEvent.click(screen.getByTestId("survey-create-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("survey-row-survey-9")).toBeInTheDocument(),
    );

    const postCall = mockFetchWithRefresh.mock.calls.find(
      (c) => c[1]?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    expect(findUrlArg(postCall!)).toBe("/api/surveys");
    const body = JSON.parse(postCall![1].body);
    expect(body.title).toBe("A Weekend with Porsche");

    const qs = body.schema.questions;
    expect(qs).toHaveLength(5);

    /* q1 — section: no answer, never required, carries body, no options. */
    expect(qs[0]).toEqual({
      id: "q1",
      type: "section",
      label: "Shape the Cayenne Experience",
      required: false,
      body: "Your feedback shapes the final experience.",
    });

    /* q2 — single_choice + allowOther + helpText. */
    expect(qs[1].id).toBe("q2");
    expect(qs[1].type).toBe("single_choice");
    expect(qs[1].required).toBe(true);
    expect(qs[1].allowOther).toBe(true);
    expect(qs[1].helpText).toBe("Select one");
    expect(qs[1].options).toEqual(["Yes", "More info", "No"]);
    expect(qs[1].visibleIf).toBeUndefined();

    /* q3 — multiple_choice + maxSelections=3 (a number). */
    expect(qs[2].id).toBe("q3");
    expect(qs[2].type).toBe("multiple_choice");
    expect(qs[2].maxSelections).toBe(3);
    expect(qs[2].options).toEqual([
      "Templates",
      "Guides",
      "Playbook",
      "Tools",
    ]);
    /* No allowOther toggled here. */
    expect(qs[2].allowOther).toBeUndefined();

    /* q4 — email. */
    expect(qs[3].id).toBe("q4");
    expect(qs[3].type).toBe("email");
    expect(qs[3].options).toBeUndefined();

    /* q5 — conditional on an earlier single_choice via `equals`. */
    expect(qs[4].id).toBe("q5");
    expect(qs[4].visibleIf).toEqual({ questionId: "q2", equals: "Yes" });
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

    /* Row reflects the published status + button flips to Unpublish
       (publishing is reversible; Unpublish stops responses without
       deleting anything). */
    await waitFor(() =>
      expect(
        screen.getByTestId("survey-row-status-survey-1"),
      ).toHaveTextContent("published"),
    );
    expect(screen.getByTestId("survey-publish-survey-1")).toHaveTextContent(
      "Unpublish",
    );
  });

  test("a linked survey shows (not re-mints) its QR inline, with a /qr link", async () => {
    // sampleSurvey2 is the linked one (qrCodeId set in the fixture).
    mockListResponse([sampleSurvey2]);
    // The QR SVG fetch (text, not json).
    mockFetchWithRefresh.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: async () =>
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180" width="180" height="180"><rect width="180" height="180" fill="#fff"/></svg>',
      }),
    );

    render(<SurveysPage />);
    await waitFor(() =>
      expect(screen.getByTestId("survey-row-survey-2")).toBeInTheDocument(),
    );

    // Linked → the button reads "Show QR", not "Generate QR".
    const qrBtn = screen.getByTestId("survey-qr-survey-2");
    expect(qrBtn).toHaveTextContent("Show QR");
    fireEvent.click(qrBtn);

    // It fetched the QR SVG by the survey's qrCodeId and rendered it.
    await waitFor(() =>
      expect(screen.getByTestId("survey-qr-svg-survey-2")).toBeInTheDocument(),
    );
    const svgCall = mockFetchWithRefresh.mock.calls.find((c) =>
      String(c[0]).includes("/api/qr/") && String(c[0]).includes("/svg"),
    );
    expect(svgCall).toBeTruthy();

    // Crucially: clicking a linked survey's QR button must NOT re-mint
    // (no POST to :id/qr).
    const mintCall = mockFetchWithRefresh.mock.calls.find(
      (c) => c[1]?.method === "POST" && String(c[0]).endsWith("/qr"),
    );
    expect(mintCall).toBeFalsy();

    // And it deep-links to THIS code on the QR page (so the user sees which
    // code is associated), not just the QR list top.
    expect(screen.getByTestId("survey-qr-manage-survey-2")).toHaveAttribute(
      "href",
      "/qr?code=qr-2",
    );

    // The public link is clickable straight to the responder.
    expect(screen.getByTestId("survey-row-link-survey-2")).toHaveAttribute(
      "href",
      "/s/xyz9876",
    );
  });

  test("Edit loads the survey into the builder and PATCHes the changes", async () => {
    mockListResponse([sampleSurvey]);
    mockFetchWithRefresh.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ survey: { ...sampleSurvey, title: "Updated title" } }),
      }),
    );

    render(<SurveysPage />);
    await waitFor(() =>
      expect(screen.getByTestId("survey-row-survey-1")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("survey-edit-survey-1"));

    // Form hydrates from the existing survey (title, slug, edit-mode submit).
    expect((screen.getByTestId("survey-create-title") as HTMLInputElement).value).toBe(
      "Post-event feedback",
    );
    expect((screen.getByTestId("survey-create-slug") as HTMLInputElement).value).toBe(
      "abc1234",
    );
    expect(screen.getByTestId("survey-create-submit")).toHaveTextContent("Save changes");
    // Its questions were hydrated into the builder rows.
    expect((screen.getByTestId("survey-q-label-0") as HTMLInputElement).value).toBe(
      "Rate us",
    );

    fireEvent.change(screen.getByTestId("survey-create-title"), {
      target: { value: "Updated title" },
    });
    fireEvent.click(screen.getByTestId("survey-create-submit"));

    await waitFor(() => {
      const patch = mockFetchWithRefresh.mock.calls.find(
        (c) => c[1]?.method === "PATCH" && String(c[0]).includes("/api/surveys/survey-1"),
      );
      expect(patch).toBeTruthy();
      expect(JSON.parse(patch![1].body).title).toBe("Updated title");
    });

    // Back to create mode after a successful save.
    await waitFor(() =>
      expect(screen.getByTestId("survey-create-submit")).toHaveTextContent(
        "Create survey",
      ),
    );
  });

  test("create sends a custom slug when one is provided", async () => {
    mockListResponse([]);
    mockFetchWithRefresh.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({
          survey: { ...sampleSurvey, id: "new", slug: "weekend-porsche" },
        }),
      }),
    );

    render(<SurveysPage />);
    await waitFor(() =>
      expect(screen.getByTestId("survey-create-form")).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByTestId("survey-create-title"), {
      target: { value: "My survey" },
    });
    fireEvent.change(screen.getByTestId("survey-create-slug"), {
      target: { value: "weekend-porsche" },
    });
    fireEvent.click(screen.getByTestId("survey-add-question"));
    fireEvent.change(screen.getByTestId("survey-q-label-0"), {
      target: { value: "How was it?" },
    });
    fireEvent.click(screen.getByTestId("survey-create-submit"));

    await waitFor(() => {
      const post = mockFetchWithRefresh.mock.calls.find(
        (c) => c[1]?.method === "POST" && String(c[0]) === "/api/surveys",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(post![1].body).slug).toBe("weekend-porsche");
    });
  });

  test("Upload survey: pasting a JSON definition POSTs and adds the survey", async () => {
    mockListResponse([]);
    mockFetchWithRefresh.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({ survey: { ...sampleSurvey, id: "up", title: "Imported" } }),
      }),
    );

    render(<SurveysPage />);
    await waitFor(() =>
      expect(screen.getByTestId("survey-upload-section")).toBeInTheDocument(),
    );

    const json = JSON.stringify({
      title: "Imported",
      schema: { questions: [{ id: "q1", type: "short_text", label: "Name", required: true }] },
    });
    fireEvent.change(screen.getByTestId("survey-upload-text"), { target: { value: json } });
    fireEvent.click(screen.getByTestId("survey-upload-submit"));

    await waitFor(() => {
      const post = mockFetchWithRefresh.mock.calls.find(
        (c) => c[1]?.method === "POST" && String(c[0]) === "/api/surveys",
      );
      expect(post).toBeTruthy();
      const body = JSON.parse(post![1].body);
      expect(body.title).toBe("Imported");
      expect(body.schema.questions).toHaveLength(1);
    });
    await waitFor(() =>
      expect(screen.getByTestId("survey-row-up")).toBeInTheDocument(),
    );
  });

  test("Upload survey: invalid JSON shows an error and does not POST", async () => {
    mockListResponse([]);
    render(<SurveysPage />);
    await waitFor(() =>
      expect(screen.getByTestId("survey-upload-text")).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId("survey-upload-text"), {
      target: { value: "{ not valid json" },
    });
    fireEvent.click(screen.getByTestId("survey-upload-submit"));
    expect(screen.getByTestId("survey-upload-error")).toBeInTheDocument();
    expect(
      mockFetchWithRefresh.mock.calls.some(
        (c) => c[1]?.method === "POST" && String(c[0]) === "/api/surveys",
      ),
    ).toBe(false);
  });

  test("a retired (archived) QR shows 'Regenerate QR', not a dead 'Show QR'", async () => {
    // qrCodeId set but qrActive:false → the linked code was archived.
    mockListResponse([{ ...sampleSurvey2, qrActive: false }]);
    render(<SurveysPage />);
    await waitFor(() =>
      expect(screen.getByTestId("survey-row-survey-2")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("survey-qr-survey-2")).toHaveTextContent("Regenerate QR");
    // Not treated as linked → no "QR linked" badge.
    expect(screen.queryByTestId("survey-row-qr-linked-survey-2")).toBeNull();
  });

  test("selecting a brand theme sends it on create", async () => {
    mockListResponse([]);
    mockFetchWithRefresh.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({ survey: { ...sampleSurvey, id: "th", theme: "porsche" } }),
      }),
    );
    render(<SurveysPage />);
    await waitFor(() =>
      expect(screen.getByTestId("survey-create-form")).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByTestId("survey-create-title"), {
      target: { value: "Porsche survey" },
    });
    fireEvent.change(screen.getByTestId("survey-create-theme"), {
      target: { value: "porsche" },
    });
    fireEvent.click(screen.getByTestId("survey-add-question"));
    fireEvent.change(screen.getByTestId("survey-q-label-0"), {
      target: { value: "How was it?" },
    });
    fireEvent.click(screen.getByTestId("survey-create-submit"));

    await waitFor(() => {
      const post = mockFetchWithRefresh.mock.calls.find(
        (c) => c[1]?.method === "POST" && String(c[0]) === "/api/surveys",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(post![1].body).theme).toBe("porsche");
    });
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

  test("view results GETs :id/insights and renders the funnel + per-question breakdown", async () => {
    mockListResponse([sampleSurvey]);
    mockFetchWithRefresh.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          insights: {
            views: 28,
            responses: 7,
            completionRate: 0.25, // 7 / 28
            avgDurationMs: 42000, // → "42s"
            firstResponseAt: "2026-06-09T01:00:00.000Z",
            lastResponseAt: "2026-06-09T05:00:00.000Z",
            byDevice: { mobile: 5, desktop: 2 },
            byCountry: { US: 7 },
            byReferrer: { qr: 4, unknown: 3 },
            perQuestion: [
              {
                questionId: "q1",
                label: "Rate us",
                type: "rating",
                answered: 7,
                average: 4.2,
              },
              {
                questionId: "q2",
                label: "Come again?",
                type: "single_choice",
                answered: 7,
                optionCounts: { Yes: 5, No: 2 },
                otherCount: 1,
                otherSamples: ["Only on weekends"],
              },
            ],
          },
        }),
      }),
    );

    render(<SurveysPage />);
    await waitFor(() =>
      expect(screen.getByTestId("survey-row-survey-1")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("survey-results-survey-1"));

    /* The panel now reads the insights endpoint, not /responses. */
    await waitFor(() => {
      const insCall = mockFetchWithRefresh.mock.calls.find((c) =>
        findUrlArg(c).includes(
          `/api/surveys/${encodeURIComponent("survey-1")}/insights`,
        ),
      );
      expect(insCall).toBeTruthy();
    });

    await waitFor(() =>
      expect(
        screen.getByTestId("survey-results-panel-survey-1"),
      ).toBeInTheDocument(),
    );

    /* Funnel headline metrics. */
    expect(
      screen.getByTestId("survey-insights-views-survey-1"),
    ).toHaveTextContent("28");
    expect(
      screen.getByTestId("survey-insights-responses-survey-1"),
    ).toHaveTextContent("7");
    /* completionRate 0.25 → "25%". */
    expect(
      screen.getByTestId("survey-insights-completion-survey-1"),
    ).toHaveTextContent("25%");
    /* avgDurationMs 42000 → "42s". */
    expect(
      screen.getByTestId("survey-insights-avgtime-survey-1"),
    ).toHaveTextContent("42s");

    /* Both per-question blocks rendered from insights.perQuestion. */
    expect(
      screen.getByTestId("survey-results-q-survey-1-0"),
    ).toHaveTextContent("Rate us");
    expect(
      screen.getByTestId("survey-results-q-survey-1-1"),
    ).toHaveTextContent("Come again?");
    /* Choice counts + an "Other" write-in surfaced. */
    expect(
      screen.getByTestId("survey-results-q-survey-1-1"),
    ).toHaveTextContent("Yes");
    expect(
      screen.getByTestId("survey-results-q-survey-1-1-other"),
    ).toHaveTextContent("Only on weekends");

    /* Toggle again hides the panel. */
    fireEvent.click(screen.getByTestId("survey-results-survey-1"));
    await waitFor(() =>
      expect(
        screen.queryByTestId("survey-results-panel-survey-1"),
      ).toBeNull(),
    );
  });

  test("view results renders the empty funnel + 'No responses yet' before any data", async () => {
    mockListResponse([sampleSurvey]);
    mockFetchWithRefresh.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          insights: {
            views: 0,
            responses: 0,
            completionRate: 0,
            avgDurationMs: null,
            firstResponseAt: null,
            lastResponseAt: null,
            byDevice: {},
            byCountry: {},
            byReferrer: {},
            perQuestion: [],
          },
        }),
      }),
    );

    render(<SurveysPage />);
    await waitFor(() =>
      expect(screen.getByTestId("survey-row-survey-1")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("survey-results-survey-1"));

    /* Wait for the funnel to render (loading state cleared). */
    await waitFor(() =>
      expect(
        screen.getByTestId("survey-insights-views-survey-1"),
      ).toBeInTheDocument(),
    );
    /* Zero-state funnel: 0 views, 0% completion, N/A time. */
    expect(
      screen.getByTestId("survey-insights-views-survey-1"),
    ).toHaveTextContent("0");
    expect(
      screen.getByTestId("survey-insights-completion-survey-1"),
    ).toHaveTextContent("0%");
    expect(
      screen.getByTestId("survey-insights-avgtime-survey-1"),
    ).toHaveTextContent("N/A");
    /* Per-question area shows the explicit empty state. */
    expect(
      screen.getByTestId("survey-results-empty-survey-1"),
    ).toBeInTheDocument();
  });
});
