/**
 * @jest-environment jsdom
 */

/**
 * Sites UI tests — render and interact with the actual Sites pages.
 *
 * Catches UX bugs that pure HTTP tests miss:
 *   - The dropzone validates a slug that doesn't exist yet
 *   - The Cancel button is detached from the form footer
 *   - Placeholders leak client-specific data
 *   - Slug input accepts invalid characters
 *   - Error messages don't auto-clear
 *   - Form fields aren't bound to state correctly
 *
 * Uses React Testing Library against the real component, with fetch +
 * router stubbed at the window level. No Next.js server required.
 */

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const pushMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

jest.mock("next/link", () => {
  const Link = ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => {
    return <a href={href} {...rest}>{children}</a>;
  };
  Link.displayName = "Link";
  return { __esModule: true, default: Link };
});

import SitesPage from "@/app/(dashboard)/sites/page";

const fetchMock = jest.fn();
beforeAll(() => {
  // @ts-expect-error override global
  global.fetch = fetchMock;
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: () => "test-token",
      setItem: jest.fn(),
      removeItem: jest.fn(),
    },
    writable: true,
  });
});

beforeEach(() => {
  fetchMock.mockReset();
  pushMock.mockReset();
  // Default: list endpoint returns empty
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ projects: [] }),
  });
});

async function openForm() {
  const newBtn = await screen.findByRole("button", { name: /\+ new site/i });
  await userEvent.click(newBtn);
}

describe("SitesPage — list & form", () => {
  it("renders the empty state then lets the user open the New Site form", async () => {
    render(<SitesPage />);
    expect(await screen.findByText(/no sites yet/i)).toBeInTheDocument();
    await openForm();
    expect(screen.getByLabelText(/slug/i, { selector: "input" })).toBeInTheDocument();
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/tagline/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/support email/i)).toBeInTheDocument();
  });

  it("placeholders are generic — no client-specific data leaks (no Aidan, CFTR, Mulready)", async () => {
    render(<SitesPage />);
    await openForm();
    const html = document.body.innerHTML;
    // The exact regression that bit us on Apr 8.
    expect(html).not.toMatch(/aidan/i);
    expect(html).not.toMatch(/cftr/i);
    expect(html).not.toMatch(/mulready/i);
    // And the new generic placeholders ARE present:
    expect(html).toMatch(/acme/i);
    expect(html).toMatch(/example\.com/i);
  });

  it("slug input sanitizes as the user types (lowercase, strips slashes/spaces)", async () => {
    render(<SitesPage />);
    await openForm();
    const slugInput = screen.getByLabelText(/slug/i, { selector: "input" }) as HTMLInputElement;
    await userEvent.type(slugInput, "/Test Co!");
    // "/Test Co!" → strip leading non-letter, lowercase, replace invalid → "test-co-"
    // After collapsing repeats and stripping leading dashes:
    expect(slugInput.value).toMatch(/^[a-z][a-z0-9-]*$/);
    expect(slugInput.value).not.toContain("/");
    expect(slugInput.value).not.toContain(" ");
    expect(slugInput.value).not.toContain("!");
  });

  it("Cancel and Create draft buttons are siblings inside the form footer", async () => {
    render(<SitesPage />);
    await openForm();
    const form = screen.getByRole("button", { name: /create draft/i }).closest("form");
    expect(form).not.toBeNull();
    expect(within(form!).getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(within(form!).getByRole("button", { name: /create draft/i })).toBeInTheDocument();
  });

  it("dropzone is INSIDE the form (not above it) and disabled until slug is valid", async () => {
    render(<SitesPage />);
    await openForm();
    // The dropzone label includes "design brief"
    const dropzone = screen.getByText(/drop a brief here to auto-fill|set a slug above first/i);
    // It must live inside the form
    expect(dropzone.closest("form")).not.toBeNull();
    // Initially shows the "set a slug first" label
    expect(dropzone.textContent).toMatch(/set a slug above first/i);

    // Type a slug — label flips
    const slugInput = screen.getByLabelText(/slug/i, { selector: "input" }) as HTMLInputElement;
    await userEvent.type(slugInput, "acme");
    await waitFor(() => {
      expect(screen.getByText(/optional.*auto-fill the rest/i)).toBeInTheDocument();
    });
  });

  it("error message auto-clears when the user starts editing the slug", async () => {
    render(<SitesPage />);
    await openForm();
    // Force an error state by submitting the form (createSite call returns an error)
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({ error: "client must be a slug" }),
    });
    const slugInput = screen.getByLabelText(/slug/i, { selector: "input" }) as HTMLInputElement;
    const nameInput = screen.getByLabelText(/display name/i) as HTMLInputElement;
    await userEvent.type(slugInput, "acme");
    await userEvent.type(nameInput, "Acme");
    await userEvent.click(screen.getByRole("button", { name: /create draft/i }));
    // Then start editing the slug — error must clear
    await userEvent.type(slugInput, "x");
    await waitFor(() => {
      expect(screen.queryByText(/client must be a slug/i)).not.toBeInTheDocument();
    });
  });

  it("create draft happy path: POSTs and refreshes the list", async () => {
    render(<SitesPage />);
    await openForm();
    // First call: list (already mocked to []). Next: create. Then list again.
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ project: { id: "site_new" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          projects: [
            {
              id: "site_new",
              client_slug: "acme",
              display_name: "Acme",
              status: "draft",
              preview_url: null,
              github_repo_url: null,
              last_canary_passed: null,
              updated_at: new Date().toISOString(),
            },
          ],
        }),
      });

    await userEvent.type(screen.getByLabelText(/slug/i, { selector: "input" }), "acme");
    await userEvent.type(screen.getByLabelText(/display name/i), "Acme");
    await userEvent.click(screen.getByRole("button", { name: /create draft/i }));
    await waitFor(() => expect(screen.getByText("Acme")).toBeInTheDocument());
  });

  it("Cancel button closes the form without submitting", async () => {
    render(<SitesPage />);
    await openForm();
    expect(screen.getByLabelText(/slug/i, { selector: "input" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    await waitFor(() => {
      expect(screen.queryByLabelText(/slug/i, { selector: "input" })).not.toBeInTheDocument();
    });
    // No POST happened (only the initial list GET)
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(0);
  });

  it("dropzone with a file: when slug is set, posts to /api/sites/parse-brief and then /api/sites", async () => {
    render(<SitesPage />);
    await openForm();
    await userEvent.type(screen.getByLabelText(/slug/i, { selector: "input" }), "acme");

    // parse-brief response, then create response
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            brief: { client: "acme", product: { name: "Acme" }, pages: [{ route: "/", sections: [] }] },
            source: "heuristic",
            tokensUsed: 0,
            confidence: "high",
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ project: { id: "site_acme" } }),
      });

    const dropzone = screen.getByText(/auto-fill the rest|design brief/i).closest("div")!;
    const file = new File(["<h1>Acme</h1>"], "brief.html", { type: "text/html" });
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [file] },
    });

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/sites/site_acme"));
    // Verify the parse-brief endpoint was called with the right slug
    const parseCall = fetchMock.mock.calls.find((c) => c[0] === "/api/sites/parse-brief");
    expect(parseCall).toBeDefined();
    const fd = parseCall![1].body as FormData;
    expect(fd.get("clientSlug")).toBe("acme");

    // CRITICAL regression: parse-brief upload must NOT include
    // Content-Type: application/json (it would override the multipart
    // boundary the browser auto-sets, and the server would 400 with
    // 'invalid body'). The exact bug user hit on Apr 8.
    const headers = (parseCall![1].headers ?? {}) as Record<string, string>;
    const ct = headers["Content-Type"] ?? headers["content-type"];
    expect(ct).toBeUndefined();
  });

  it("FormData uploads must NEVER carry an explicit Content-Type header", async () => {
    // Belt-and-braces: this test fails the moment any multipart upload
    // path on this page sets Content-Type, regardless of which call site.
    render(<SitesPage />);
    await openForm();
    await userEvent.type(screen.getByLabelText(/slug/i, { selector: "input" }), "acme");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ brief: { client: "acme", product: { name: "Acme" }, pages: [] }, source: "heuristic", tokensUsed: 0, confidence: "high" }),
    });
    const dropzone = screen.getByText(/auto-fill the rest|design brief/i).closest("div")!;
    fireEvent.drop(dropzone, { dataTransfer: { files: [new File(["x"], "a.html", { type: "text/html" })] } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    for (const call of fetchMock.mock.calls) {
      const [, init] = call as [string, RequestInit | undefined];
      if (init?.body instanceof FormData) {
        const headers = (init.headers ?? {}) as Record<string, string>;
        const ct = headers["Content-Type"] ?? headers["content-type"];
        expect(ct).toBeUndefined();
      }
    }
  });
});
