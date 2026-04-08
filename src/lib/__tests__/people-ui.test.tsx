/**
 * @jest-environment jsdom
 */

/**
 * People page UI tests — render and interact with the actual tabs.
 *
 * Catches the Sites-style regressions (multipart Content-Type leaks,
 * dropzone disabled state, accept/reject loop) for the new HR feature.
 */

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("next/link", () => {
  const Link = ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>;
  Link.displayName = "Link";
  return { __esModule: true, default: Link };
});

import PeoplePage from "@/app/(dashboard)/people/page";

const fetchMock = jest.fn();
beforeAll(() => {
  // @ts-expect-error override
  global.fetch = fetchMock;
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: {} as Record<string, string>,
      getItem(this: { _store: Record<string, string> }, k: string) { return this._store[k] ?? "test-token"; },
      setItem(this: { _store: Record<string, string> }, k: string, v: string) { this._store[k] = v; },
      removeItem(this: { _store: Record<string, string> }, k: string) { delete this._store[k]; },
    },
    writable: true,
  });
});

beforeEach(() => {
  fetchMock.mockReset();
  // Default: every list endpoint returns empty
  fetchMock.mockImplementation((url: string) => {
    if (url.includes("/employees")) return Promise.resolve({ ok: true, json: async () => ({ employees: [] }) });
    if (url.includes("/benefits")) return Promise.resolve({ ok: true, json: async () => ({ documents: [] }) });
    if (url.includes("/insights")) return Promise.resolve({ ok: true, json: async () => ({ insights: [] }) });
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
});

describe("PeoplePage — tab navigation", () => {
  it("renders Overview tab by default with three count cards", async () => {
    render(<PeoplePage />);
    // "Benefits documents" + "Open insights" only appear in the Overview cards
    await waitFor(() => expect(screen.getByText(/Benefits documents/i)).toBeInTheDocument());
    expect(screen.getByText(/Open insights/i)).toBeInTheDocument();
    // "Employees" appears as both a tab and a card — use getAllByText
    expect(screen.getAllByText(/Employees/i).length).toBeGreaterThanOrEqual(2);
  });

  it("switches to Benefits tab when clicked", async () => {
    render(<PeoplePage />);
    const benefitsTab = await screen.findByRole("tab", { name: /benefits/i });
    await userEvent.click(benefitsTab);
    expect(await screen.findByText(/Drop a benefits renewal PDF/i)).toBeInTheDocument();
  });

  it("switches to Employees tab when clicked", async () => {
    render(<PeoplePage />);
    await userEvent.click(screen.getByRole("tab", { name: /employees/i }));
    expect(await screen.findByText(/\+ Add employee/i)).toBeInTheDocument();
  });

  it("switches to Insights tab when clicked", async () => {
    render(<PeoplePage />);
    await userEvent.click(screen.getByRole("tab", { name: /insights/i }));
    await waitFor(() => expect(screen.getByText(/No insights yet/i)).toBeInTheDocument());
  });
});

describe("BenefitsTab — upload flow", () => {
  it("dropzone POSTs to /api/people/benefits and renders the recommendation card", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/people/benefits" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              documentId: "bd_1",
              planCount: 5,
              carrier: "Blue Cross Blue Shield",
              effectiveDate: "Dec 1, 2025",
              recommendation: {
                id: "rec_1",
                rule: "cheapest_practical",
                plan_id: "S9N1ADT",
                plan_name: "HMO Silver",
                reasoning: "S9N1ADT (HMO Silver) — $0 primary care, $515/mo",
                runners_up: [],
              },
              insights: [
                { title: "HMO is $593/mo cheaper than PPO", body: "...", severity: "info", category: "benefits" },
              ],
            }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ documents: [], employees: [], insights: [] }) });
    });

    render(<PeoplePage />);
    await userEvent.click(await screen.findByRole("tab", { name: /benefits/i }));
    const dropzone = (await screen.findByText(/Drop a benefits renewal PDF/i)).closest("div")!;
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(["%PDF"], "renewal.pdf", { type: "application/pdf" })] },
    });

    await waitFor(() => expect(screen.getAllByText(/S9N1ADT/i).length).toBeGreaterThan(0));
    expect(screen.getByText(/cheapest practical/i)).toBeInTheDocument();
    expect(screen.getByText(/HMO is \$593\/mo cheaper than PPO/i)).toBeInTheDocument();
  });

  it("upload POST must NOT include Content-Type header (multipart regression)", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/people/benefits" && init?.method === "POST") {
        const headers = (init.headers ?? {}) as Record<string, string>;
        const ct = headers["Content-Type"] ?? headers["content-type"];
        expect(ct).toBeUndefined();
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ documentId: "bd_1", planCount: 0, carrier: null, effectiveDate: null, recommendation: null, insights: [] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ documents: [] }) });
    });
    render(<PeoplePage />);
    await userEvent.click(await screen.findByRole("tab", { name: /benefits/i }));
    const dropzone = (await screen.findByText(/Drop a benefits renewal PDF/i)).closest("div")!;
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(["%PDF"], "x.pdf", { type: "application/pdf" })] },
    });
    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) => c[0] === "/api/people/benefits" && c[1]?.method === "POST");
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  it("Accept button on the recommendation calls the recommendations PATCH endpoint", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/people/benefits" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              documentId: "bd_1",
              planCount: 1,
              carrier: "BCBS",
              effectiveDate: null,
              recommendation: {
                id: "rec_42",
                rule: "cheapest_practical",
                plan_id: "S9N1ADT",
                plan_name: null,
                reasoning: "—",
                runners_up: [],
              },
              insights: [],
            }),
        });
      }
      if (url.startsWith("/api/people/recommendations/")) {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ documents: [], employees: [], insights: [] }) });
    });
    render(<PeoplePage />);
    await userEvent.click(await screen.findByRole("tab", { name: /benefits/i }));
    const dropzone = (await screen.findByText(/Drop a benefits renewal PDF/i)).closest("div")!;
    fireEvent.drop(dropzone, { dataTransfer: { files: [new File(["%PDF"], "x.pdf", { type: "application/pdf" })] } });
    const acceptBtn = await screen.findByRole("button", { name: /^Accept$/i });
    await userEvent.click(acceptBtn);
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find((c) => c[0] === "/api/people/recommendations/rec_42");
      expect(patchCall).toBeDefined();
      expect(patchCall![1].method).toBe("PATCH");
      expect(JSON.parse(patchCall![1].body as string)).toEqual({ outcome: "accepted" });
    });
    expect(await screen.findByText(/Decision recorded/i)).toBeInTheDocument();
  });
});
