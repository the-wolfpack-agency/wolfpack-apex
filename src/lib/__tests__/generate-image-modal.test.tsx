/**
 * @jest-environment jsdom
 */

/**
 * GenerateImageModal — mount-based tests for the non-technical team's
 * image-generation UI.
 *
 * Covers:
 *  - Does not render when closed
 *  - Renders prompt textarea + 5 aspect-ratio radios when open
 *  - Fires site.image_gen_opened analytics on open
 *  - Typing > 500 chars surfaces the red counter; Generate blocked
 *  - Clicking Generate fires a POST to /api/sites/:id/generate-image
 *    with prompt + aspectRatio + sectionPath
 *  - On 200, preview image renders + Use / Try again / Cancel buttons show
 *  - "Use this image" fires onAccept + site.image_gen_accepted
 *  - "Try another" fires a second POST + site.image_gen_regenerated event
 *  - "Cancel" fires onClose + site.image_gen_dismissed event
 *  - Error response surfaces server error message verbatim (never masked)
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, waitFor } from "@testing-library/react";

// /api/analytics mock — the modal fires-and-forgets events via
// fetchWithRefresh. We mock BOTH paths: the generate-image call goes
// through an injected fetchImpl prop for test isolation, and the
// analytics call goes through the (mocked) fetchWithRefresh.
const mockAnalyticsFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) => mockAnalyticsFetch(...args),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { GenerateImageModal } from "@/components/sites/GenerateImageModal";

/** Real fetch sets `ok` for 2xx ONLY, never for a 3xx. These fakes said
 *  `status < 400`, so a redirect would have read as success. No test here
 *  currently uses a 3xx, so it was a trap rather than a live bug — corrected
 *  alongside the same mistake found in the compliance collector (PR #224). */
function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

function makeFetchImpl(
  responses: Array<{ status?: number; json: Record<string, unknown> }>,
) {
  let call = 0;
  return jest.fn(async (_url: string, _init?: RequestInit) => {
    const r = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return {
      ok: isOk(r.status ?? 200),
      status: r.status ?? 200,
      json: async () => r.json,
    } as unknown as Response;
  });
}

beforeEach(() => {
  mockAnalyticsFetch.mockReset();
  mockAnalyticsFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({}),
  });
});

describe("<GenerateImageModal />", () => {
  test("does not render when open=false", () => {
    const { queryByRole } = render(
      <GenerateImageModal
        open={false}
        projectId="site_1"
        sectionPath="/pages/0/sections/0/backgroundImage"
        onClose={() => {}}
        onAccept={() => {}}
      />,
    );
    expect(queryByRole("dialog")).toBeNull();
  });

  test("opens, fires image_gen_opened analytics, shows textarea + 5 aspect-ratio radios", async () => {
    const { getByRole, getAllByRole, getByLabelText } = render(
      <GenerateImageModal
        open={true}
        projectId="site_1"
        sectionPath="/pages/0/sections/0/backgroundImage"
        onClose={() => {}}
        onAccept={() => {}}
      />,
    );
    expect(getByRole("dialog")).toBeInTheDocument();
    expect(getByLabelText("Describe the image you want")).toBeInTheDocument();
    expect(getAllByRole("radio")).toHaveLength(5);

    // image_gen_opened was fired on mount via useEffect.
    await waitFor(() => {
      expect(mockAnalyticsFetch).toHaveBeenCalledWith(
        "/api/analytics",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("site.image_gen_opened"),
        }),
      );
    });
  });

  test("prompt counter turns red past 500 chars and Generate surfaces the length error", async () => {
    const fetchImpl = makeFetchImpl([{ status: 200, json: {} }]);
    const { getByLabelText, getByText, container } = render(
      <GenerateImageModal
        open={true}
        projectId="site_1"
        sectionPath="/pages/0/sections/0/backgroundImage"
        onClose={() => {}}
        onAccept={() => {}}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    const textarea = getByLabelText(
      "Describe the image you want",
    ) as HTMLTextAreaElement;
    const longPrompt = "a".repeat(520);
    fireEvent.change(textarea, { target: { value: longPrompt } });
    // Counter shows character count
    expect(container.textContent).toContain("520 / 500");
    // Click Generate — should surface length error without calling fetch
    fireEvent.click(getByText("Generate"));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getByText(/max is 500/i)).toBeInTheDocument();
  });

  test("selecting aspect ratio updates aria-checked on the radio group", () => {
    const { getAllByRole } = render(
      <GenerateImageModal
        open={true}
        projectId="site_1"
        sectionPath="/pages/0/sections/0/backgroundImage"
        onClose={() => {}}
        onAccept={() => {}}
      />,
    );
    const radios = getAllByRole("radio");
    // Default: 16:9 (first)
    expect(radios[0]).toHaveAttribute("aria-checked", "true");
    expect(radios[2]).toHaveAttribute("aria-checked", "false");
    // Click the square (1:1) option
    fireEvent.click(radios[2]);
    expect(radios[2]).toHaveAttribute("aria-checked", "true");
    expect(radios[0]).toHaveAttribute("aria-checked", "false");
  });

  test("Generate fires POST with prompt + aspectRatio + sectionPath; 200 renders preview + action buttons", async () => {
    const fetchImpl = makeFetchImpl([
      {
        status: 200,
        json: {
          url: "https://raw.githubusercontent.com/acme/site/main/public/generated/img_gen_1.jpg",
          generationId: "img_gen_1",
        },
      },
    ]);
    const onAccept = jest.fn();
    const { getByLabelText, getByText, getAllByRole, queryByText } = render(
      <GenerateImageModal
        open={true}
        projectId="site_1"
        sectionPath="/pages/0/sections/0/backgroundImage"
        onClose={() => {}}
        onAccept={onAccept}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    // Type + pick aspect ratio
    fireEvent.change(getByLabelText("Describe the image you want"), {
      target: { value: "A sunlit office" },
    });
    fireEvent.click(getAllByRole("radio")[2]); // 1:1

    await act(async () => {
      fireEvent.click(getByText("Generate"));
    });

    // Server received prompt + aspectRatio + sectionPath
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/sites/site_1/generate-image",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"prompt":"A sunlit office"'),
      }),
    );
    const firstCall = fetchImpl.mock.calls[0];
    const lastBody = JSON.parse((firstCall[1] as RequestInit).body as string);
    expect(lastBody).toEqual({
      prompt: "A sunlit office",
      aspectRatio: "1:1",
      sectionPath: "/pages/0/sections/0/backgroundImage",
    });

    // Preview image appears
    await waitFor(() => {
      expect(
        document.querySelector("[data-generated-preview]"),
      ).toBeInTheDocument();
    });
    expect(getByText("Use this image")).toBeInTheDocument();
    expect(getByText("Try another variation")).toBeInTheDocument();
    // Initial "Generate" button is gone
    expect(queryByText("Generate")).toBeNull();
  });

  test("Use this image fires onAccept(url, generationId) + site.image_gen_accepted analytics", async () => {
    const fetchImpl = makeFetchImpl([
      {
        status: 200,
        json: {
          url: "https://raw.githubusercontent.com/acme/site/main/public/generated/img_gen_1.jpg",
          generationId: "img_gen_1",
        },
      },
    ]);
    const onAccept = jest.fn();
    const onClose = jest.fn();

    const { getByLabelText, getByText } = render(
      <GenerateImageModal
        open={true}
        projectId="site_1"
        sectionPath="/pages/0/sections/0/backgroundImage"
        onClose={onClose}
        onAccept={onAccept}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    fireEvent.change(getByLabelText("Describe the image you want"), {
      target: { value: "A sunlit office" },
    });
    await act(async () => {
      fireEvent.click(getByText("Generate"));
    });
    await waitFor(() =>
      expect(
        document.querySelector("[data-generated-preview]"),
      ).toBeInTheDocument(),
    );
    fireEvent.click(getByText("Use this image"));

    expect(onAccept).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/acme/site/main/public/generated/img_gen_1.jpg",
      "img_gen_1",
    );
    expect(onClose).toHaveBeenCalled();
    expect(mockAnalyticsFetch).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        body: expect.stringContaining("site.image_gen_accepted"),
      }),
    );
  });

  test("Try another variation fires a second POST + site.image_gen_regenerated event", async () => {
    const fetchImpl = makeFetchImpl([
      {
        status: 200,
        json: {
          url: "https://.../v1.jpg",
          generationId: "img_gen_1",
        },
      },
      {
        status: 200,
        json: {
          url: "https://.../v2.jpg",
          generationId: "img_gen_2",
        },
      },
    ]);
    const { getByLabelText, getByText } = render(
      <GenerateImageModal
        open={true}
        projectId="site_1"
        sectionPath="/pages/0/sections/0/backgroundImage"
        onClose={() => {}}
        onAccept={() => {}}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );

    fireEvent.change(getByLabelText("Describe the image you want"), {
      target: { value: "office" },
    });
    await act(async () => {
      fireEvent.click(getByText("Generate"));
    });
    await waitFor(() =>
      expect(
        document.querySelector("[data-generated-preview]"),
      ).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.click(getByText("Try another variation"));
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(mockAnalyticsFetch).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        body: expect.stringContaining("site.image_gen_regenerated"),
      }),
    );
  });

  test("Cancel fires onClose + site.image_gen_dismissed", () => {
    const onClose = jest.fn();
    const { getByText } = render(
      <GenerateImageModal
        open={true}
        projectId="site_1"
        sectionPath="/pages/0/sections/0/backgroundImage"
        onClose={onClose}
        onAccept={() => {}}
      />,
    );
    fireEvent.click(getByText("Cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(mockAnalyticsFetch).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        body: expect.stringContaining("site.image_gen_dismissed"),
      }),
    );
  });

  test("server error response surfaces the error message verbatim (never 'Something went wrong')", async () => {
    const fetchImpl = makeFetchImpl([
      {
        status: 503,
        json: {
          error:
            "The AI image generator is not configured in this environment. An admin must set FAL_API_KEY.",
          reason: "ai_not_configured",
        },
      },
    ]);
    const { getByLabelText, getByText } = render(
      <GenerateImageModal
        open={true}
        projectId="site_1"
        sectionPath="/pages/0/sections/0/backgroundImage"
        onClose={() => {}}
        onAccept={() => {}}
        fetchImpl={fetchImpl as unknown as typeof fetch}
      />,
    );
    fireEvent.change(getByLabelText("Describe the image you want"), {
      target: { value: "office" },
    });
    await act(async () => {
      fireEvent.click(getByText("Generate"));
    });
    await waitFor(() =>
      expect(document.querySelector("[data-error]")).toBeInTheDocument(),
    );
    // Exact server message — not a generic "something went wrong"
    expect(
      document.querySelector("[data-error]")!.textContent,
    ).toContain("FAL_API_KEY");
    expect(
      document.querySelector("[data-error]")!.textContent,
    ).not.toMatch(/something went wrong/i);
  });
});
