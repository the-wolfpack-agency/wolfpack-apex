/**
 * @jest-environment jsdom
 */

/**
 * BenefitsTab regression locks.
 *
 * The full upload + render + delete flows live in hr-documents-ui.test.tsx
 * (the smart-router flow). This file is intentionally narrow — it locks
 * the production bugs we already fixed so they can't regress:
 *
 *   1. PG NUMERIC strings render without crashing the parsed plans table
 *   2. recommendation with no runners_up does not crash
 *   3. 500 server error is shown to the user, not silently swallowed
 *   4. multipart upload must NOT carry an explicit Content-Type header
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

import HrPage from "@/app/(dashboard)/hr/page";

const fetchMock = jest.fn();
beforeAll(() => {
  // @ts-expect-error global override
  global.fetch = fetchMock;
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: { instinct_token: "tok" } as Record<string, string>,
      getItem(this: { _store: Record<string, string> }, k: string) { return this._store[k] ?? null; },
      setItem(this: { _store: Record<string, string> }, k: string, v: string) { this._store[k] = v; },
      removeItem(this: { _store: Record<string, string> }, k: string) { delete this._store[k]; },
    },
    writable: true,
  });
});

beforeEach(() => {
  fetchMock.mockReset();
});

/**
 * Smart-router stub: dropping a "renewal.pdf" returns benefits_renewal
 * with a benefitDocumentId so the BenefitsTab populates the
 * recommendation card. The detail GET returns whatever the test stubs
 * for that document id.
 */
function stubBenefitsHappyPath(detailGet: () => Promise<unknown>) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url === "/api/people/documents" && method === "POST") {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            documentId: "hd_1",
            filename: "renewal.pdf",
            category: "benefits_renewal",
            confidence: 0.9,
            reasons: ["test"],
            benefitDocumentId: "bd_1",
            benefitPlanCount: 2,
            benefitRecommendation: { id: "rec_1", plan_id: "S9N1ADT", reasoning: "—" },
          }),
      });
    }
    if (url === "/api/people/benefits/bd_1" && method === "GET") {
      return Promise.resolve({ ok: true, json: detailGet });
    }
    if (url === "/api/people/benefits" && method === "GET") {
      return Promise.resolve({ ok: true, json: async () => ({ documents: [] }) });
    }
    return Promise.resolve({ ok: true, json: async () => ({ documents: [], employees: [], insights: [] }) });
  });
}

async function dropPdf(filename = "renewal.pdf") {
  await userEvent.click(await screen.findByRole("tab", { name: /^benefits$/i }));
  const dropzone = (await screen.findByText(/Drop a benefits renewal PDF/i)).closest("div")!;
  fireEvent.drop(dropzone, {
    dataTransfer: { files: [new File(["%PDF"], filename, { type: "application/pdf" })] },
  });
}

describe("BenefitsTab regression locks", () => {
  it("parsed plans table renders when PG returns numerics as STRINGS (toFixed regression)", async () => {
    stubBenefitsHappyPath(async () => ({
      document: { id: "bd_1" },
      plans: [
        {
          plan_id: "S9N1ADT",
          network: "HMO",
          metal_tier: "Silver",
          is_hsa: false,
          // STRINGS, not numbers — what raw PG returns
          individual_deductible_in_network: "4100",
          individual_oop_max_in_network: "9200",
          primary_care_copay: "$0/$0",
          primary_care_copay_in_network: "0",
          monthly_premium_age_employee_only: "515.43",
        },
      ],
      recommendations: [],
      raw_text_excerpt: "",
    }));
    render(<HrPage />);
    await dropPdf();
    // The render must NOT crash and must show the formatted premium
    await waitFor(() => expect(screen.getByText("$515.43")).toBeInTheDocument(), { timeout: 3000 });
  });

  it("recommendation with NO runners_up does not crash (length-of-undefined regression)", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/people/documents" && method === "POST") {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              documentId: "hd_x",
              filename: "x.pdf",
              category: "benefits_renewal",
              confidence: 0.9,
              reasons: [],
              benefitDocumentId: "bd_x",
              benefitPlanCount: 1,
              // runners_up intentionally absent (not even an empty array)
              benefitRecommendation: { id: "rec_x", plan_id: "X1", reasoning: "—" },
            }),
        });
      }
      if (url === "/api/people/benefits/bd_x" && method === "GET") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ document: { id: "bd_x" }, plans: [], recommendations: [], raw_text_excerpt: "" }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ documents: [], employees: [], insights: [] }) });
    });
    render(<HrPage />);
    await dropPdf("x.pdf");
    await waitFor(() => expect(screen.getAllByText(/X1/).length).toBeGreaterThan(0), { timeout: 3000 });
  });

  it("500 server error path: surfaces the error message in the UI (does not silently swallow)", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/people/documents" && init?.method === "POST") {
        return Promise.resolve({
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ error: "upload failed: DOMMatrix is not defined" }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ documents: [], employees: [], insights: [] }) });
    });
    render(<HrPage />);
    await dropPdf();
    await waitFor(() => expect(screen.getByText(/Upload failed \(500\)/i)).toBeInTheDocument());
  });

  it("multipart upload must NOT carry explicit Content-Type header (auth header regression)", async () => {
    let postCall: { headers: Record<string, string> } | null = null;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/api/people/documents" && init?.method === "POST") {
        postCall = { headers: (init.headers ?? {}) as Record<string, string> };
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ documentId: "hd_1", filename: "x.pdf", category: "unclassified", confidence: 0, reasons: [] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({ documents: [], employees: [], insights: [] }) });
    });
    render(<HrPage />);
    await dropPdf("x.pdf");
    await waitFor(() => expect(postCall).not.toBeNull());
    const ct = postCall!.headers["Content-Type"] ?? postCall!.headers["content-type"];
    expect(ct).toBeUndefined();
  });
});
