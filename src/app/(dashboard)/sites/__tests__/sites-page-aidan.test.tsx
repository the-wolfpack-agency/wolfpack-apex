/**
 * @jest-environment jsdom
 */

/**
 * Sites list — renders the adopted wolfpack-aidan-mulready row.
 *
 * Pair test for migration 081_adopt_wolfpack_aidan_mulready. The migration
 * INSERTs the row into instinct_site_projects (via the apex_site_projects
 * compat view); GET /api/sites surfaces it in `{ projects: [...] }`; and
 * <SitesPage /> renders a card per project. This test mocks the fetch so
 * the suite runs offline and asserts the DOM contract a client would
 * actually see — display_name visible, preview URL linked, status pill
 * shows "ready", client_slug shown as the secondary identifier.
 *
 * Nick's 2026-04-24 ask on this safety net: "we must know if anything
 * breaks because clients will experience the bug." No toBeTruthy-style
 * assertions — every assertion pins a specific visible element.
 */

import "@testing-library/jest-dom";
import { render, screen, waitFor, within } from "@testing-library/react";

const pushMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
}));

jest.mock("next/link", () => {
  const Link = ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  Link.displayName = "Link";
  return { __esModule: true, default: Link };
});

// Stub client-auth so fetchWithRefresh routes through our jest fetch mock
// and getInstinctToken always returns a fake token (the page bails out
// without one).
const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...a: unknown[]) => unknown)(...args),
  authHeaders: () => ({ Authorization: "Bearer fake" }),
  jsonHeaders: () => ({
    Authorization: "Bearer fake",
    "Content-Type": "application/json",
  }),
  getInstinctToken: () => "fake-token",
}));

import SitesPage from "@/app/(dashboard)/sites/page";

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

const AIDAN_ROW = {
  id: "site_aidan_mulready_cftr",
  client_slug: "aidan-mulready",
  display_name: "Aidan Mulready — CFTR",
  status: "ready" as const,
  preview_url: "https://wolfpack-aidan-mulready.vercel.app",
  github_repo_url:
    "https://github.com/the-wolfpack-agency/wolfpack-aidan-mulready",
  last_canary_passed: true,
  updated_at: "2026-04-24T12:00:00.000Z",
};

function mockSitesListReturning(projects: Array<typeof AIDAN_ROW>) {
  mockFetchWithRefresh.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ projects }),
  });
}

describe("SitesPage — adopted wolfpack-aidan-mulready row", () => {
  it("renders the display_name as a visible card heading", async () => {
    mockSitesListReturning([AIDAN_ROW]);
    render(<SitesPage />);
    // Wait for load() to resolve and the empty-state to clear.
    await waitFor(() => {
      expect(
        screen.queryByText(/no sites yet/i),
      ).not.toBeInTheDocument();
    });
    expect(
      await screen.findByText("Aidan Mulready — CFTR"),
    ).toBeInTheDocument();
  });

  it("renders the client_slug under the display_name for quick identification", async () => {
    mockSitesListReturning([AIDAN_ROW]);
    render(<SitesPage />);
    // The secondary line is `${slug} · updated ${date}`.
    const slugLine = await screen.findByText(/aidan-mulready\s*·/);
    expect(slugLine).toBeInTheDocument();
  });

  it("renders the status pill with the text 'READY' (uppercased via CSS)", async () => {
    mockSitesListReturning([AIDAN_ROW]);
    render(<SitesPage />);
    const title = await screen.findByText("Aidan Mulready — CFTR");
    // The status pill lives in the same Link card as the title.
    const card = title.closest("a");
    expect(card).not.toBeNull();
    // Raw text is "ready" — text-transform: uppercase is applied via
    // inline style so the DOM contains the lowercase original. Assert
    // against the actual DOM string.
    expect(within(card as HTMLElement).getByText("ready")).toBeInTheDocument();
  });

  it("links the preview URL to https://wolfpack-aidan-mulready.vercel.app", async () => {
    mockSitesListReturning([AIDAN_ROW]);
    render(<SitesPage />);
    await screen.findByText("Aidan Mulready — CFTR");
    // The card link wraps the whole row (href=/sites/{id}) AND contains
    // a nested <a> to the preview URL. Filter links by href prefix so we
    // grab the preview-specific anchor, not the outer drill-in link.
    const allLinks = screen.getAllByRole("link");
    const previewLink = allLinks.find(
      (l) => l.getAttribute("href")?.startsWith("https://wolfpack-aidan-mulready"),
    );
    expect(previewLink).toBeDefined();
    expect(previewLink!.getAttribute("href")).toBe(
      "https://wolfpack-aidan-mulready.vercel.app",
    );
    expect(previewLink!.textContent).toMatch(/Preview/);
  });

  it("preview link opens in a new tab (target=_blank, rel=noreferrer)", async () => {
    mockSitesListReturning([AIDAN_ROW]);
    render(<SitesPage />);
    await screen.findByText("Aidan Mulready — CFTR");
    const allLinks = screen.getAllByRole("link");
    const previewLink = allLinks.find(
      (l) => l.getAttribute("href") === "https://wolfpack-aidan-mulready.vercel.app",
    );
    expect(previewLink).toBeDefined();
    expect(previewLink!).toHaveAttribute("target", "_blank");
    expect(previewLink!).toHaveAttribute("rel", "noreferrer");
  });

  it("card itself links to /sites/{id} for drill-in to the editor", async () => {
    mockSitesListReturning([AIDAN_ROW]);
    render(<SitesPage />);
    const title = await screen.findByText("Aidan Mulready — CFTR");
    const card = title.closest("a");
    expect(card).toHaveAttribute("href", "/sites/site_aidan_mulready_cftr");
  });

  it("renders an accessible Archive button labeled with the display_name", async () => {
    mockSitesListReturning([AIDAN_ROW]);
    render(<SitesPage />);
    await screen.findByText("Aidan Mulready — CFTR");
    const archiveBtn = screen.getByRole("button", {
      name: /archive aidan mulready/i,
    });
    expect(archiveBtn).toBeInTheDocument();
  });

  it("GET /api/sites was called (offline — never hits the network)", async () => {
    mockSitesListReturning([AIDAN_ROW]);
    render(<SitesPage />);
    await waitFor(() => {
      expect(mockFetchWithRefresh).toHaveBeenCalledWith(
        "/api/sites",
        expect.any(Object),
      );
    });
  });

  it("empty response still renders the empty state (no stray Aidan row)", async () => {
    mockSitesListReturning([]);
    const { container } = render(<SitesPage />);
    expect(await screen.findByText(/no sites yet/i)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Aidan Mulready — CFTR/);
  });
});
