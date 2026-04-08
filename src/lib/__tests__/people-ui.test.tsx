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

  it("upload completion path: parsed plans table renders + raw text panel + delete works", async () => {
    let docDeleted = false;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/people/benefits" && method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              documentId: "bd_99",
              planCount: 2,
              carrier: "BCBS",
              effectiveDate: "Dec 1, 2025",
              recommendation: {
                id: "rec_99",
                rule: "cheapest_practical",
                plan_id: "S9N1ADT",
                plan_name: "HMO Silver",
                reasoning: "...",
                runners_up: [],
              },
              insights: [],
            }),
        });
      }
      if (url === "/api/people/benefits/bd_99" && method === "GET") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            document: { id: "bd_99", filename: "renewal.pdf" },
            plans: [
              { plan_id: "S9N1ADT", network: "HMO", metal_tier: "Silver", is_hsa: false, individual_deductible_in_network: 4100, individual_oop_max_in_network: 9200, primary_care_copay: "$0/$0", primary_care_copay_in_network: 0, monthly_premium_age_employee_only: 515.43 },
              { plan_id: "G9K8CHC", network: "PPO", metal_tier: "Gold", is_hsa: false, individual_deductible_in_network: 1050, individual_oop_max_in_network: 6300, primary_care_copay: "$55/$55", primary_care_copay_in_network: 55, monthly_premium_age_employee_only: 974.99 },
            ],
            recommendations: [],
            raw_text_excerpt: "S9N1ADT $4100// $9200//\n$515.43",
          }),
        });
      }
      if (url === "/api/people/benefits" && method === "GET") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            documents: docDeleted
              ? []
              : [{ id: "bd_99", filename: "renewal.pdf", carrier: "BCBS", effective_date: null, page_count: 7, uploaded_at: new Date().toISOString() }],
          }),
        });
      }
      if (url === "/api/people/benefits/bd_99" && method === "DELETE") {
        docDeleted = true;
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ documents: [], employees: [], insights: [] }) });
    });

    render(<PeoplePage />);
    await userEvent.click(await screen.findByRole("tab", { name: /benefits/i }));
    const dropzone = (await screen.findByText(/Drop a benefits renewal PDF/i)).closest("div")!;
    fireEvent.drop(dropzone, { dataTransfer: { files: [new File(["%PDF"], "renewal.pdf", { type: "application/pdf" })] } });

    // Recommendation card
    await waitFor(() => expect(screen.getAllByText(/S9N1ADT/i).length).toBeGreaterThan(0));

    // Parsed plans table appears with both rows + non-null premiums
    await waitFor(() => expect(screen.getByText("Parsed plans (2)")).toBeInTheDocument());
    expect(screen.getByText("$515.43")).toBeInTheDocument();
    expect(screen.getByText("$974.99")).toBeInTheDocument();

    // Raw text excerpt panel exists (collapsed details element)
    expect(screen.getByText(/Show raw extracted text/i)).toBeInTheDocument();

    // Confirm dialog stub for delete
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
    const deleteBtn = screen.getByRole("button", { name: /^Delete$/i });
    await userEvent.click(deleteBtn);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^Delete$/i })).not.toBeInTheDocument();
    });
    confirmSpy.mockRestore();
  });

  it("upload error path: 500 server error is shown to the user (the production crash regression)", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/people/benefits" && init?.method === "POST") {
        return Promise.resolve({
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ error: "parse failed: DOMMatrix is not defined" }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ documents: [], employees: [], insights: [] }) });
    });
    render(<PeoplePage />);
    await userEvent.click(await screen.findByRole("tab", { name: /benefits/i }));
    const dropzone = (await screen.findByText(/Drop a benefits renewal PDF/i)).closest("div")!;
    fireEvent.drop(dropzone, { dataTransfer: { files: [new File(["%PDF"], "x.pdf", { type: "application/pdf" })] } });
    await waitFor(() => expect(screen.getByText(/Parse failed \(500\)/i)).toBeInTheDocument());
  });

  it("parsed plans table renders when premium values are STRINGS (PG NUMERIC regression — toFixed crash)", async () => {
    // node-postgres returns NUMERIC columns as strings by default. The
    // bug: client called .toFixed() on a string and crashed the entire
    // page render. This test asserts string values are coerced safely.
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/people/benefits" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              documentId: "bd_pg",
              planCount: 1,
              carrier: "BCBS",
              effectiveDate: null,
              recommendation: { id: "r", rule: "cheapest_practical", plan_id: "S9N1ADT", plan_name: null, reasoning: "—", runners_up: [] },
              insights: [],
            }),
        });
      }
      if (url === "/api/people/benefits/bd_pg" && (init?.method ?? "GET") === "GET") {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            document: { id: "bd_pg" },
            // Every numeric is a STRING — exactly what raw PG returns
            plans: [
              {
                plan_id: "S9N1ADT",
                network: "HMO",
                metal_tier: "Silver",
                is_hsa: false,
                individual_deductible_in_network: "4100",
                individual_oop_max_in_network: "9200",
                primary_care_copay: "$0/$0",
                primary_care_copay_in_network: "0",
                monthly_premium_age_employee_only: "515.43",
              },
            ],
            recommendations: [],
            raw_text_excerpt: "",
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ documents: [], employees: [], insights: [] }) });
    });
    render(<PeoplePage />);
    await userEvent.click(await screen.findByRole("tab", { name: /benefits/i }));
    const dropzone = (await screen.findByText(/Drop a benefits renewal PDF/i)).closest("div")!;
    fireEvent.drop(dropzone, { dataTransfer: { files: [new File(["%PDF"], "x.pdf", { type: "application/pdf" })] } });
    // The render must NOT crash and must show the formatted premium
    await waitFor(() => expect(screen.getByText("$515.43")).toBeInTheDocument());
    expect(screen.getByText("$4100")).toBeInTheDocument();
    expect(screen.getByText("$9200")).toBeInTheDocument();
  });

  it("recommendation with NO runners_up does not crash (regression — previously threw on .length of undefined)", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/people/benefits" && init?.method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 200,
          // recommendation.runners_up missing entirely
          text: async () =>
            JSON.stringify({
              documentId: "bd_x",
              planCount: 1,
              carrier: null,
              effectiveDate: null,
              recommendation: {
                id: "rec_x",
                rule: "cheapest_practical",
                plan_id: "X1",
                plan_name: null,
                reasoning: "—",
                // runners_up intentionally absent
              },
              insights: [],
            }),
        });
      }
      if (url.startsWith("/api/people/benefits/bd_x")) {
        return Promise.resolve({ ok: true, json: async () => ({ document: { id: "bd_x" }, plans: [], recommendations: [], raw_text_excerpt: "" }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ documents: [], employees: [], insights: [] }) });
    });
    render(<PeoplePage />);
    await userEvent.click(await screen.findByRole("tab", { name: /benefits/i }));
    const dropzone = (await screen.findByText(/Drop a benefits renewal PDF/i)).closest("div")!;
    fireEvent.drop(dropzone, { dataTransfer: { files: [new File(["%PDF"], "x.pdf", { type: "application/pdf" })] } });
    // Page must NOT crash; recommendation card should render
    await waitFor(() => expect(screen.getAllByText(/X1/).length).toBeGreaterThan(0));
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
