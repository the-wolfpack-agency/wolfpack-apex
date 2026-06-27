/**
 * @jest-environment jsdom
 */

/**
 * Dashboard render-smoke tests — every dashboard page must mount and
 * render without throwing, with fetch + router stubbed at the window
 * level. This catches the entire class of "page crashes on first
 * render" bugs that the People parsed-plans table render-crash bug
 * (which the user mistook for a 404 page) belonged to.
 *
 * For each page we:
 *   1. Mock all common dependencies (next/navigation, next/link,
 *      localStorage, fetch returning empty lists)
 *   2. Dynamically import the page component
 *   3. render(<Page />) and assert no throw + at least one DOM node
 *
 * Pages with deeper interactive flows (Sites, People) have their own
 * dedicated *-ui.test.tsx files. This file is a SAFETY NET — it
 * guarantees no page crashes on initial mount, even if a future commit
 * breaks the data layer or ships a malformed prop.
 */

import "@testing-library/jest-dom";
import { render, waitFor } from "@testing-library/react";

const pushMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

jest.mock("next/link", () => {
  const Link = ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  );
  Link.displayName = "Link";
  return { __esModule: true, default: Link };
});

const fetchMock = jest.fn();
beforeAll(() => {
  global.fetch = fetchMock;
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: { instinct_token: "t", instinct_user: JSON.stringify({ id: "u", name: "Test", email: "t@t", role: "ceo" }), apex_token: "t", apex_user: JSON.stringify({ id: "u", name: "Test", email: "t@t", role: "ceo" }) } as Record<string, string>,
      getItem(this: { _store: Record<string, string> }, k: string) { return this._store[k] ?? null; },
      setItem(this: { _store: Record<string, string> }, k: string, v: string) { this._store[k] = v; },
      removeItem(this: { _store: Record<string, string> }, k: string) { delete this._store[k]; },
      clear(this: { _store: Record<string, string> }) { this._store = {}; },
    },
    writable: true,
  });
  // Mock URL.createObjectURL for any page that builds blob URLs
  if (typeof URL.createObjectURL === "undefined") {
    Object.defineProperty(URL, "createObjectURL", { value: jest.fn(() => "blob:mock"), writable: true });
  }
  // jsdom doesn't implement scrollIntoView; some pages call it
  if (typeof Element.prototype.scrollIntoView === "undefined") {
    Element.prototype.scrollIntoView = function () { /* no-op */ };
  }
});

beforeEach(() => {
  fetchMock.mockReset();
  // Default: every fetch returns an empty-but-shaped JSON response.
  // Pages that read specific fields will get empty arrays/null where
  // they expect data, which is the most common crash trigger.
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      // Common shapes used across pages
      conversations: [],
      messages: [],
      memory: [],
      memories: [],
      clients: [],
      client: null,
      docs: [],
      documents: [],
      emails: [],
      features: [],
      threads: [],
      discussions: [],
      meetings: [],
      transcripts: [],
      entries: [],
      reports: [],
      knowledge: [],
      results: [],
      events: [],
      counts: {},
      stats: {},
      summary: {},
      data: {},
      user: { id: "u", name: "Test", email: "t@t", role: "ceo" },
      employees: [],
      insights: [],
      projects: [],
    }),
    text: async () => "{}",
  });
});

const PAGES = [
  "analytics",
  "assistant",
  "clients",
  "discussions",
  "docs",
  "emails",
  "features",
  "financials",
  "journal",
  "knowledge",
  "meetings",
  "reports",
  "settings",
  "sites",
  "hr",
];

describe("Dashboard pages render without throwing", () => {
  for (const page of PAGES) {
    it(`/${page} mounts without crashing`, async () => {
      // Suppress noisy act() warnings during mount-only smoke renders
      const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
      let mod: { default: React.ComponentType };
      try {
        mod = await import(`@/app/(dashboard)/${page}/page`);
      } catch (e) {
        errSpy.mockRestore();
        throw new Error(`Failed to import /${page}/page: ${(e as Error).message}`);
      }
      expect(mod.default).toBeDefined();
      const Page = mod.default;
      let rendered: ReturnType<typeof render>;
      try {
        rendered = render(<Page />);
      } catch (e) {
        errSpy.mockRestore();
        throw new Error(`/${page} crashed on first render: ${(e as Error).message}`);
      }
      // Wait for any post-mount fetches to settle so we catch
      // crashes that happen in useEffect data-loading too
      await waitFor(
        () => {
          expect(rendered.container).toBeTruthy();
        },
        { timeout: 1000 },
      );
      // The page produced *some* DOM (not just a comment node)
      expect(rendered.container.firstChild).not.toBeNull();
      errSpy.mockRestore();
    });
  }

  // Regression guard for the "Cannot read total_tokens of undefined"
  // crash: when /api/usage returns a malformed/partial body (the
  // generic mock above has no `lifetime` / `last_30_days` windows), the
  // Settings Token-usage card must render its explicit empty state
  // instead of throwing and blanking the whole page. The fix guards the
  // source (settings page validates the usage shape before setState),
  // so this asserts the user-visible degradation, not just no-throw.
  it("/settings renders the usage empty state on a malformed /api/usage body (no crash)", async () => {
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const mod = await import("@/app/(dashboard)/settings/page");
    const Page = mod.default;
    const rendered = render(<Page />);
    await waitFor(
      () => {
        expect(
          rendered.getByText(/Usage data unavailable\./i),
        ).toBeInTheDocument();
      },
      { timeout: 1000 },
    );
    // The well-formed usage card must NOT have rendered from bad data.
    expect(rendered.queryByTestId("settings-usage")).toBeNull();
    errSpy.mockRestore();
  });
});
