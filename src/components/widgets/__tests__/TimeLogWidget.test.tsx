/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * TimeLogWidget — cascading Client/Category → Job Code picker that
 * lets a user update Program / PO Number / PO Amount on an existing
 * row of the SharePoint workbook.
 *
 * These tests pin:
 *   1. The catalog loads from /api/job-codes on mount.
 *   2. Picking a category filters the code dropdown.
 *   3. Picking a code surfaces the three editable fields with the
 *      current values from `extra`.
 *   4. Submit PATCHes /api/job-codes/[code]/cell ONCE PER CHANGED
 *      column, sending the right `column` letter (D/E/F).
 *   5. Read-only users (no jobcodes.refresh) see fields disabled and
 *      Submit is gated.
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
}));

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TimeLogWidget } from "@/components/widgets/TimeLogWidget";

function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
}

const SAMPLE = [
  { code: "WPA-1", description: "Acme dealer DOS", extra: { "Client/Category": "Acme", "Program": "P1", "PO Number": "PO-1", "PO Amount": "100" } },
  { code: "WPA-2", description: "Acme other", extra: { "Client/Category": "Acme", "Program": "", "PO Number": "", "PO Amount": "" } },
  { code: "GLB-1", description: "Globex retainer", extra: { "Client/Category": "Globex", "Program": "Annual", "PO Number": "PO-9", "PO Amount": "500" } },
];

const spec = { kind: "time_log", submitUrl: "/api/time-entries" } as any;

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("<TimeLogWidget /> cascading flow", () => {
  it("loads the catalog and exposes distinct categories", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ capabilities: ["jobcodes.view", "jobcodes.refresh"] }))
      .mockResolvedValueOnce(mkRes({})) // analytics widget_rendered
      .mockResolvedValueOnce(mkRes({ codes: SAMPLE, columns: ["Code", "Description", "Client/Category", "Program", "PO Number", "PO Amount"] }))
      .mockResolvedValue(mkRes({}));

    await act(async () => {
      render(<TimeLogWidget spec={spec} />);
    });
    const cat = await screen.findByTestId("time-log-category");
    const options = Array.from(cat.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(["Acme", "Globex"]));
  });

  it("picking a category filters the code dropdown", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ capabilities: ["jobcodes.view", "jobcodes.refresh"] }))
      .mockResolvedValueOnce(mkRes({}))
      .mockResolvedValueOnce(mkRes({ codes: SAMPLE, columns: [] }))
      .mockResolvedValue(mkRes({}));

    await act(async () => {
      render(<TimeLogWidget spec={spec} />);
    });
    const cat = await screen.findByTestId("time-log-category");
    await act(async () => {
      fireEvent.change(cat, { target: { value: "Acme" } });
    });
    const code = await screen.findByTestId("time-log-code");
    const opts = Array.from(code.querySelectorAll("option")).map((o) => o.getAttribute("value"));
    expect(opts).toEqual(expect.arrayContaining(["WPA-1", "WPA-2"]));
    expect(opts).not.toContain("GLB-1");
  });

  it("picking a code surfaces D/E/F values; submit PATCHes only changed fields", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ capabilities: ["jobcodes.view", "jobcodes.refresh"] }))
      .mockResolvedValueOnce(mkRes({}))
      .mockResolvedValueOnce(mkRes({ codes: SAMPLE, columns: [] }))
      .mockResolvedValueOnce(mkRes({ ok: true, new_value: "Phase 2" })) // PATCH Program
      .mockResolvedValueOnce(mkRes({ ok: true, new_value: "PO-NEW" }))  // PATCH PO Number
      .mockResolvedValueOnce(mkRes({ codes: SAMPLE, columns: [] }))      // reload after submit
      .mockResolvedValue(mkRes({}));

    await act(async () => {
      render(<TimeLogWidget spec={spec} />);
    });
    fireEvent.change(await screen.findByTestId("time-log-category"), { target: { value: "Acme" } });
    fireEvent.change(await screen.findByTestId("time-log-code"), { target: { value: "WPA-1" } });

    /* Initial values pulled from extra. */
    const progField = await screen.findByTestId("time-log-field-D") as HTMLInputElement;
    const poField = await screen.findByTestId("time-log-field-E") as HTMLInputElement;
    const amtField = await screen.findByTestId("time-log-field-F") as HTMLInputElement;
    expect(progField.value).toBe("P1");
    expect(poField.value).toBe("PO-1");
    expect(amtField.value).toBe("100");

    /* User edits two of the three; PO Amount stays at "100". */
    fireEvent.change(progField, { target: { value: "Phase 2" } });
    fireEvent.change(poField, { target: { value: "PO-NEW" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("time-log-submit"));
    });

    const patches = mockFetchWithRefresh.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("/api/job-codes/WPA-1/cell"),
    );
    expect(patches).toHaveLength(2);
    const bodies = patches.map((c) => JSON.parse((c[1] as { body: string }).body));
    expect(bodies).toContainEqual({ column: "D", value: "Phase 2" });
    expect(bodies).toContainEqual({ column: "E", value: "PO-NEW" });
    /* PO Amount was unchanged → no patch for column F. */
    expect(bodies.find((b) => b.column === "F")).toBeUndefined();
  });

  it("disables fields and Submit when caller lacks jobcodes.refresh", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkRes({ capabilities: ["jobcodes.view"] })) // no refresh
      .mockResolvedValueOnce(mkRes({}))
      .mockResolvedValueOnce(mkRes({ codes: SAMPLE, columns: [] }))
      .mockResolvedValue(mkRes({}));
    await act(async () => {
      render(<TimeLogWidget spec={spec} />);
    });
    fireEvent.change(await screen.findByTestId("time-log-category"), { target: { value: "Acme" } });
    fireEvent.change(await screen.findByTestId("time-log-code"), { target: { value: "WPA-1" } });
    const progField = await screen.findByTestId("time-log-field-D") as HTMLInputElement;
    expect(progField).toBeDisabled();
    const submit = screen.getByTestId("time-log-submit") as HTMLButtonElement;
    expect(submit).toBeDisabled();
  });
});
