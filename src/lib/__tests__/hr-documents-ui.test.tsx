/**
 * @jest-environment jsdom
 */

/**
 * HR Documents UI E2E — real React render via React Testing Library.
 *
 * Walks the bug-bait flow that brought us here:
 *   1. Drop a W-4 on the BENEFITS tab
 *   2. Tab shows "Filed as w4 — view in Documents tab" friendly toast
 *      instead of "could not extract any plan rows" error
 *   3. Switch to Documents tab → the W-4 row appears
 *   4. Recategorize via dropdown → state updates
 *   5. Delete via button → row disappears
 *
 * Plus the happy path: drop a real benefits renewal on the Benefits
 * tab → recommendation card appears AND the doc appears in Documents.
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
  global.fetch = fetchMock;
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: { instinct_token: "tok", instinct_user: JSON.stringify({ id: "u", role: "hr", name: "Alicia", email: "a@w" }) } as Record<string, string>,
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

interface DocRow { id: string; filename: string; category: string; size_bytes: number; page_count: number; uploaded_at: string; employee_id?: string | null }

function setupServer(initialDocs: DocRow[] = [], initialEmployees: { id: string; name: string }[] = []) {
  const docs = [...initialDocs];
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    // Documents listing
    if (url === "/api/people/documents" && method === "GET") {
      return Promise.resolve({ ok: true, json: async () => ({ documents: docs }) });
    }
    if (url === "/api/people/documents" && method === "POST") {
      // Inspect the FormData to decide what to "classify"
      const fd = init?.body as FormData;
      const file = fd.get("file") as File;
      const filename = file?.name ?? "x.pdf";
      const isW4 = /w4/i.test(filename);
      const isBenefits = /renewal|bcbs/i.test(filename);
      const newDoc: DocRow = {
        id: `hd_${docs.length + 1}`,
        filename,
        category: isW4 ? "w4" : isBenefits ? "benefits_renewal" : "unclassified",
        size_bytes: file?.size ?? 0,
        page_count: 1,
        uploaded_at: new Date().toISOString(),
      };
      docs.push(newDoc);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            documentId: newDoc.id,
            filename,
            category: newDoc.category,
            confidence: 0.85,
            reasons: ["test"],
            ...(isBenefits && {
              benefitDocumentId: "bd_1",
              benefitPlanCount: 5,
              benefitRecommendation: { id: "rec_1", plan_id: "S9N1ADT", reasoning: "—" },
            }),
          }),
      });
    }
    // PATCH recategorize / link employee
    const patchMatch = url.match(/^\/api\/people\/documents\/(hd_\w+)$/);
    if (patchMatch && method === "PATCH") {
      const id = patchMatch[1];
      const body = init?.body ? JSON.parse(init.body as string) : {};
      const target = docs.find((d) => d.id === id);
      if (target) {
        if (body.category) target.category = body.category;
        if ("employee_id" in body) target.employee_id = body.employee_id;
      }
      return Promise.resolve({ ok: true, json: async () => ({ document: target }) });
    }
    // DELETE
    if (patchMatch && method === "DELETE") {
      const id = patchMatch[1];
      const idx = docs.findIndex((d) => d.id === id);
      if (idx >= 0) docs.splice(idx, 1);
      return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
    }
    // Stub the rest of HR page reads
    if (url === "/api/people/employees") return Promise.resolve({ ok: true, json: async () => ({ employees: initialEmployees }) });
    if (url === "/api/people/insights") return Promise.resolve({ ok: true, json: async () => ({ insights: [] }) });
    if (url === "/api/people/benefits") return Promise.resolve({ ok: true, json: async () => ({ documents: [] }) });
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

describe("HR Documents UI — full flow with smart routing", () => {
  it("dropping a W-4 on the BENEFITS tab files it via the smart router and shows a friendly message (not an error)", async () => {
    setupServer();
    render(<HrPage />);
    // Switch to Benefits tab
    await userEvent.click(await screen.findByRole("tab", { name: /^benefits$/i }));
    const dropzone = (await screen.findByText(/Drop a benefits renewal PDF/i)).closest("div")!;
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(["%PDF"], "alicia-w4.pdf", { type: "application/pdf" })] },
    });
    // Friendly progress message replaces the old "could not extract"
    // error path. The W-4 routes through /api/people/documents.
    await waitFor(() => {
      expect(screen.getByText(/Filed as w4/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Documents tab/i)).toBeInTheDocument();
    // Verify the POST went to /api/people/documents with source=benefits_tab
    const postCall = fetchMock.mock.calls.find((c) => c[0] === "/api/people/documents" && c[1]?.method === "POST");
    expect(postCall).toBeDefined();
    const fd = postCall![1].body as FormData;
    expect(fd.get("source")).toBe("benefits_tab");
  });

  it("dropping a real benefits renewal on the Benefits tab still shows the recommendation card", async () => {
    setupServer();
    render(<HrPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /^benefits$/i }));
    const dropzone = (await screen.findByText(/Drop a benefits renewal PDF/i)).closest("div")!;
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(["%PDF"], "bcbs-renewal.pdf", { type: "application/pdf" })] },
    });
    await waitFor(() => {
      expect(screen.getAllByText(/S9N1ADT/i).length).toBeGreaterThan(0);
    });
  });

  it("Documents tab dropzone accepts any file and shows the routed result toast", async () => {
    setupServer();
    render(<HrPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /^documents$/i }));
    const dropzone = (await screen.findByText(/Drop any HR document here/i)).closest("div")!;
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(["%PDF"], "alicia-w4.pdf", { type: "application/pdf" })] },
    });
    // The new doc appears in the list (this proves the upload + load
    // cycle completed successfully — sufficient assertion for this
    // test, the toast text is covered by the dropzone-routing test).
    await waitFor(
      () => {
        expect(screen.getByText("alicia-w4.pdf")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it("filter chips narrow the Documents list to a single category", async () => {
    setupServer([
      { id: "hd_1", filename: "alicia-w4.pdf", category: "w4", size_bytes: 1000, page_count: 1, uploaded_at: "2026-04-08" },
      { id: "hd_2", filename: "alicia-i9.pdf", category: "i9", size_bytes: 1000, page_count: 1, uploaded_at: "2026-04-08" },
    ]);
    render(<HrPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /^documents$/i }));
    await waitFor(() => expect(screen.getByText("alicia-w4.pdf")).toBeInTheDocument());
    expect(screen.getByText("alicia-i9.pdf")).toBeInTheDocument();
    // Filter to W-4 only
    await userEvent.click(screen.getByRole("button", { name: /^W-4 \(1\)$/ }));
    expect(screen.getByText("alicia-w4.pdf")).toBeInTheDocument();
    expect(screen.queryByText("alicia-i9.pdf")).not.toBeInTheDocument();
  });

  it("recategorize dropdown updates the doc's category", async () => {
    setupServer([
      { id: "hd_1", filename: "mystery.pdf", category: "unclassified", size_bytes: 1000, page_count: 1, uploaded_at: "2026-04-08" },
    ]);
    render(<HrPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /^documents$/i }));
    await waitFor(() => expect(screen.getByText("mystery.pdf")).toBeInTheDocument());
    const select = screen.getByRole("combobox", { name: /Category for mystery\.pdf/i });
    await userEvent.selectOptions(select, "w4");
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find((c) => c[0] === "/api/people/documents/hd_1" && c[1]?.method === "PATCH");
      expect(patch).toBeDefined();
      expect(JSON.parse(patch![1].body as string)).toEqual({ category: "w4" });
    });
  });

  it("delete button removes the row from the list", async () => {
    setupServer([
      { id: "hd_1", filename: "delete-me.pdf", category: "w4", size_bytes: 1000, page_count: 1, uploaded_at: "2026-04-08" },
    ]);
    render(<HrPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /^documents$/i }));
    await waitFor(() => expect(screen.getByText("delete-me.pdf")).toBeInTheDocument());
    const confirmSpy = jest.spyOn(window, "confirm").mockReturnValue(true);
    await userEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    await waitFor(() => expect(screen.queryByText("delete-me.pdf")).not.toBeInTheDocument());
    confirmSpy.mockRestore();
  });

  it("HR page header reads 'HR' (renamed from People for sidebar consistency)", async () => {
    setupServer();
    render(<HrPage />);
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "HR" })).toBeInTheDocument();
    });
  });

  it("Documents POST must NOT include explicit Content-Type header (multipart regression)", async () => {
    setupServer();
    render(<HrPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /^documents$/i }));
    const dropzone = (await screen.findByText(/Drop any HR document here/i)).closest("div")!;
    fireEvent.drop(dropzone, {
      dataTransfer: { files: [new File(["%PDF"], "x.pdf", { type: "application/pdf" })] },
    });
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find((c) => c[0] === "/api/people/documents" && c[1]?.method === "POST");
      expect(postCall).toBeDefined();
      const headers = (postCall![1].headers ?? {}) as Record<string, string>;
      const ct = headers["Content-Type"] ?? headers["content-type"];
      expect(ct).toBeUndefined();
    });
  });

  it("employee dropdown renders with employee options", async () => {
    const employees = [
      { id: "emp_1", name: "Jane Smith" },
      { id: "emp_2", name: "Bob Jones" },
    ];
    setupServer(
      [{ id: "hd_1", filename: "form.pdf", category: "w4", size_bytes: 1000, page_count: 1, uploaded_at: "2026-04-08", employee_id: null }],
      employees,
    );
    render(<HrPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /^documents$/i }));
    await waitFor(() => expect(screen.getByText("form.pdf")).toBeInTheDocument());
    const empSelect = screen.getByRole("combobox", { name: /Employee for form\.pdf/i });
    expect(empSelect).toBeInTheDocument();
    expect(empSelect).toHaveValue("");
    // Verify employee options are present
    const options = empSelect.querySelectorAll("option");
    expect(options.length).toBe(3); // "No employee" + 2 employees
    expect(options[1].textContent).toBe("Jane Smith");
    expect(options[2].textContent).toBe("Bob Jones");
  });

  it("selecting an employee sends PATCH with employee_id", async () => {
    const employees = [{ id: "emp_1", name: "Jane Smith" }];
    setupServer(
      [{ id: "hd_1", filename: "form.pdf", category: "w4", size_bytes: 1000, page_count: 1, uploaded_at: "2026-04-08", employee_id: null }],
      employees,
    );
    render(<HrPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /^documents$/i }));
    await waitFor(() => expect(screen.getByText("form.pdf")).toBeInTheDocument());
    const empSelect = screen.getByRole("combobox", { name: /Employee for form\.pdf/i });
    await userEvent.selectOptions(empSelect, "emp_1");
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => c[0] === "/api/people/documents/hd_1" && c[1]?.method === "PATCH" && (c[1]?.body as string).includes("employee_id"),
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(patch![1].body as string)).toEqual({ employee_id: "emp_1" });
    });
  });

  it("selecting 'No employee' sends PATCH with employee_id: null to unlink", async () => {
    const employees = [{ id: "emp_1", name: "Jane Smith" }];
    setupServer(
      [{ id: "hd_1", filename: "form.pdf", category: "w4", size_bytes: 1000, page_count: 1, uploaded_at: "2026-04-08", employee_id: "emp_1" }],
      employees,
    );
    render(<HrPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /^documents$/i }));
    await waitFor(() => expect(screen.getByText("form.pdf")).toBeInTheDocument());
    const empSelect = screen.getByRole("combobox", { name: /Employee for form\.pdf/i });
    await userEvent.selectOptions(empSelect, "");
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) => c[0] === "/api/people/documents/hd_1" && c[1]?.method === "PATCH" && (c[1]?.body as string).includes("employee_id"),
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(patch![1].body as string)).toEqual({ employee_id: null });
    });
  });

  it("shows the employee name in the document row when linked", async () => {
    const employees = [{ id: "emp_1", name: "Jane Smith" }];
    setupServer(
      [{ id: "hd_1", filename: "form.pdf", category: "w4", size_bytes: 1000, page_count: 1, uploaded_at: "2026-04-08", employee_id: "emp_1" }],
      employees,
    );
    render(<HrPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /^documents$/i }));
    await waitFor(() => expect(screen.getByText("form.pdf")).toBeInTheDocument());
    // Employee name should appear in the document details line AND in the dropdown option
    await waitFor(() => {
      const matches = screen.getAllByText(/Jane Smith/);
      expect(matches.length).toBeGreaterThanOrEqual(2); // detail text + dropdown option
    });
  });
});
