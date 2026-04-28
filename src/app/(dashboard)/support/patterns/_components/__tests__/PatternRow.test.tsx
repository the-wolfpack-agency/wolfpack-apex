/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: jest.fn(),
  getInstinctToken: jest.fn(() => "tk"),
}));

import { fetchWithRefresh } from "@/lib/client-auth";
import PatternRow from "@/app/(dashboard)/support/patterns/_components/PatternRow";
import type { SupportPattern } from "@/lib/support/types";

const mockedFetch = fetchWithRefresh as jest.MockedFunction<
  typeof fetchWithRefresh
>;

function makePattern(overrides: Partial<SupportPattern> = {}): SupportPattern {
  return {
    id: "p-1",
    slug: "aadsts50126-bad-credentials",
    name: "Microsoft 365 sign-in fails with AADSTS50126",
    category: "auth",
    match_signatures: [{ type: "regex", pattern: "AADSTS50126" }],
    draft_template: "Hi {{first_name}}…",
    success_count: 4,
    fail_count: 1,
    enabled: true,
    auto_acknowledge_enabled: false,
    auto_acknowledge_template: null,
    created_at: "2026-04-27T00:00:00Z",
    updated_at: "2026-04-27T00:00:00Z",
    ...overrides,
  };
}

/* jsdom env in this test file does NOT polyfill global `Response`. We
   only need .ok and .json() at the call site, so a hand-rolled stub
   keeps the test independent of any whatwg-fetch shim. */
function makeRes(
  body: unknown,
  init: { status?: number } = { status: 200 },
): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("<PatternRow />", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  test("renders DISABLED auto-ack state with the gray toggle", () => {
    const p = makePattern({ auto_acknowledge_enabled: false });
    render(<PatternRow pattern={p} onPatched={() => {}} />);

    const toggle = screen.getByTestId(`pattern-row-toggle-auto-ack-${p.id}`);
    expect(toggle.getAttribute("data-on")).toBe("false");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.textContent).toMatch(/Auto-ack: off/);
    /* Gray = the (160,168,180) muted token, NOT the green (80,175,110). */
    expect(toggle.style.background).toContain("160, 168, 180");
    expect(toggle.style.background).not.toContain("80, 175, 110");

    /* Counts row renders with the success/fail tallies. */
    expect(
      screen.getByTestId(`pattern-row-counts-${p.id}`).textContent,
    ).toMatch(/4/);
  });

  test("renders ENABLED auto-ack state with the green toggle", () => {
    const p = makePattern({ auto_acknowledge_enabled: true });
    render(<PatternRow pattern={p} onPatched={() => {}} />);

    const toggle = screen.getByTestId(`pattern-row-toggle-auto-ack-${p.id}`);
    expect(toggle.getAttribute("data-on")).toBe("true");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.textContent).toMatch(/Auto-ack: on/);
    expect(toggle.style.background).toContain("80, 175, 110");
  });

  test("clicking the auto-ack toggle PATCHes /api/support/patterns/[id] with the inverted boolean and calls onPatched", async () => {
    const p = makePattern({ auto_acknowledge_enabled: false });
    const after: SupportPattern = { ...p, auto_acknowledge_enabled: true };
    mockedFetch.mockResolvedValueOnce(makeRes({ pattern: after }));
    const onPatched = jest.fn();

    render(<PatternRow pattern={p} onPatched={onPatched} />);
    fireEvent.click(
      screen.getByTestId(`pattern-row-toggle-auto-ack-${p.id}`),
    );

    await waitFor(() => expect(onPatched).toHaveBeenCalledTimes(1));
    expect(onPatched).toHaveBeenCalledWith(after);

    expect(mockedFetch).toHaveBeenCalledWith(
      `/api/support/patterns/${p.id}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ auto_acknowledge_enabled: true }),
      }),
    );
  });

  test("expand → edit template → save calls PATCH with auto_acknowledge_template and shows the saved pulse", async () => {
    const p = makePattern({
      auto_acknowledge_enabled: true,
      auto_acknowledge_template: "Old template body.",
    });
    const newText = "Hi there, please try resetting your password first.";
    const after: SupportPattern = { ...p, auto_acknowledge_template: newText };
    mockedFetch.mockResolvedValueOnce(makeRes({ pattern: after }));
    const onPatched = jest.fn();

    render(<PatternRow pattern={p} onPatched={onPatched} />);

    /* Edit panel hidden by default. */
    expect(
      screen.queryByTestId(`pattern-row-edit-panel-${p.id}`),
    ).not.toBeInTheDocument();

    /* Click the row header to expand. */
    fireEvent.click(screen.getByTestId(`pattern-row-expand-${p.id}`));
    expect(
      screen.getByTestId(`pattern-row-edit-panel-${p.id}`),
    ).toBeInTheDocument();

    /* Save button is disabled while clean. */
    const saveButton = screen.getByTestId(
      `pattern-row-save-template-${p.id}`,
    ) as HTMLButtonElement;
    expect(saveButton.disabled).toBe(true);

    const textarea = screen.getByTestId(`pattern-row-template-${p.id}`);
    fireEvent.change(textarea, { target: { value: newText } });

    /* Now dirty → button enabled. */
    expect(
      (
        screen.getByTestId(
          `pattern-row-save-template-${p.id}`,
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    await act(async () => {
      fireEvent.click(screen.getByTestId(`pattern-row-save-template-${p.id}`));
    });

    expect(mockedFetch).toHaveBeenCalledWith(
      `/api/support/patterns/${p.id}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ auto_acknowledge_template: newText }),
      }),
    );

    await waitFor(() => expect(onPatched).toHaveBeenCalledWith(after));

    /* Saved pulse appears on the save button. */
    const button = screen.getByTestId(
      `pattern-row-save-template-${p.id}`,
    ) as HTMLButtonElement;
    expect(button.textContent).toMatch(/Saved/);
  });
});
