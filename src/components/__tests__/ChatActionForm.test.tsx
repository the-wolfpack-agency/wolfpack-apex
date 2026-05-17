/**
 * @jest-environment jsdom
 *
 * ChatActionForm — required-field gate, submit lifecycle, success +
 * failure rendering. Mocks fetchWithRefresh so we don't hit the
 * network.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { ChatActionForm } from "@/components/ChatActionForm";
import type { FormSpec } from "@/lib/assistant/forms/types";

const emailSpec: FormSpec = {
  formKind: "create_email",
  title: "Create email",
  fields: [
    { name: "to", label: "To *", type: "email", required: true },
    { name: "subject", label: "Subject *", type: "text", required: true },
    { name: "body", label: "Message *", type: "textarea", required: true },
  ],
  submitLabel: "Send email",
};

beforeEach(() => mockFetch.mockReset());

function getSubmitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /send email/i }) as HTMLButtonElement;
}

function typeInto(testId: string, value: string) {
  const el = screen.getByTestId(testId) as HTMLInputElement | HTMLTextAreaElement;
  /* React controlled-input: set value via the native setter so the
     synthetic onChange fires. */
  const proto = el.tagName === "TEXTAREA"
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ChatActionForm — required-field gate", () => {
  test("submit button is disabled until every required field is filled", () => {
    render(<ChatActionForm spec={emailSpec} />);
    expect(getSubmitButton()).toBeDisabled();
    typeInto("chat-action-form-input-to", "alice@example.com");
    expect(getSubmitButton()).toBeDisabled(); // subject + body still missing
    typeInto("chat-action-form-input-subject", "Q3 plan");
    expect(getSubmitButton()).toBeDisabled(); // body still missing
    typeInto("chat-action-form-input-body", "Hi Alice — here are the notes.");
    expect(getSubmitButton()).not.toBeDisabled();
  });

  test("whitespace-only value still keeps button disabled (no accidental sends)", () => {
    render(<ChatActionForm spec={emailSpec} />);
    typeInto("chat-action-form-input-to", "alice@example.com");
    typeInto("chat-action-form-input-subject", "   ");
    typeInto("chat-action-form-input-body", "ok");
    expect(getSubmitButton()).toBeDisabled();
  });
});

describe("ChatActionForm — submit success", () => {
  test("POSTs to /api/assistant/forms/submit with form fields, renders ack", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, message: "Sent email to alice@example.com." }),
    });
    render(<ChatActionForm spec={emailSpec} />);
    typeInto("chat-action-form-input-to", "alice@example.com");
    typeInto("chat-action-form-input-subject", "Q3 plan");
    typeInto("chat-action-form-input-body", "Hello.");
    await act(async () => fireEvent.click(getSubmitButton()));

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/assistant/forms/submit",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.formKind).toBe("create_email");
    expect(body.fields.to).toBe("alice@example.com");
    expect(body.fields.subject).toBe("Q3 plan");
    expect(body.fields.body).toBe("Hello.");

    await waitFor(() =>
      expect(screen.getByTestId("chat-action-form-success-create_email")).toBeInTheDocument(),
    );
    /* Form inputs are gone after success — replaced by ack pill. */
    expect(screen.queryByTestId("chat-action-form-input-to")).toBeNull();
  });

  test("calls onSubmitted callback with result", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, message: "Sent.", resourceId: "msg-1" }),
    });
    const cb = jest.fn();
    render(<ChatActionForm spec={emailSpec} onSubmitted={cb} />);
    typeInto("chat-action-form-input-to", "a@b.co");
    typeInto("chat-action-form-input-subject", "s");
    typeInto("chat-action-form-input-body", "b");
    await act(async () => fireEvent.click(getSubmitButton()));
    await waitFor(() => expect(cb).toHaveBeenCalledTimes(1));
    expect(cb.mock.calls[0][0]).toMatchObject({
      ok: true,
      message: "Sent.",
      resourceId: "msg-1",
    });
  });
});

describe("ChatActionForm — submit failure", () => {
  test("server validation errors surface as field-level errors", async () => {
    mockFetch.mockImplementationOnce(async () => ({
      ok: false,
      json: async () => ({
        ok: false,
        code: "validation",
        message: "Some required fields are missing.",
        fieldErrors: { to: "Invalid email" },
      }),
    }));
    render(<ChatActionForm spec={emailSpec} />);
    typeInto("chat-action-form-input-to", "not-an-email");
    typeInto("chat-action-form-input-subject", "s");
    typeInto("chat-action-form-input-body", "b");
    /* Submit the form directly — bypassing the button click avoids any
       jsdom quirks around form submission semantics. */
    const form = screen.getByTestId("chat-action-form-create_email");
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() =>
      expect(screen.getByTestId("chat-action-form-error-create_email")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("chat-action-form-field-error-to").textContent).toContain("Invalid email");
    /* Inputs still visible — user can fix + retry. */
    expect(screen.getByTestId("chat-action-form-input-to")).toBeInTheDocument();
  });

  test("auth failure surfaces top-level error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        ok: false,
        code: "auth",
        message: "Microsoft account not connected.",
      }),
    });
    render(<ChatActionForm spec={emailSpec} />);
    typeInto("chat-action-form-input-to", "a@b.co");
    typeInto("chat-action-form-input-subject", "s");
    typeInto("chat-action-form-input-body", "b");
    await act(async () => fireEvent.click(getSubmitButton()));
    await waitFor(() =>
      expect(screen.getByTestId("chat-action-form-error-create_email").textContent)
        .toContain("Microsoft account not connected"),
    );
  });
});

describe("ChatActionForm — field-level analytics", () => {
  test("submitting with an optional field blank fires assistant.form_field_skipped", async () => {
    const specWithOptionalCc: FormSpec = {
      ...emailSpec,
      fields: [
        ...emailSpec.fields,
        { name: "cc", label: "Cc", type: "email", required: false },
      ],
    };
    /* First call is the analytics POST for `cc`, second is the
     * submit. Both succeed. */
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, message: "Sent." }),
    });
    render(<ChatActionForm spec={specWithOptionalCc} />);
    typeInto("chat-action-form-input-to", "a@b.co");
    typeInto("chat-action-form-input-subject", "s");
    typeInto("chat-action-form-input-body", "b");
    await act(async () => fireEvent.click(getSubmitButton()));
    /* Confirm at least one analytics call carried form_field_skipped + field_name=cc. */
    const analyticsCalls = mockFetch.mock.calls.filter(
      (c) => c[0] === "/api/analytics",
    );
    const skipBodies = analyticsCalls
      .map((c) => c[1]?.body || "")
      .filter((b: string) => b.includes("form_field_skipped"));
    expect(skipBodies.length).toBeGreaterThan(0);
    expect(skipBodies[0]).toContain('"field_name":"cc"');
  });

  test("server-side fieldErrors fire one assistant.form_field_invalid per field", async () => {
    /* Default mock so the trackFieldEvent analytics POSTs return a
     * resolvable Promise (otherwise undefined.catch throws + halts
     * the iteration after the first field). */
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      json: async () => ({
        ok: false,
        code: "validation",
        message: "Check the highlighted fields.",
        fieldErrors: { to: "Invalid email", subject: "Required" },
      }),
    });
    render(<ChatActionForm spec={emailSpec} />);
    typeInto("chat-action-form-input-to", "alice@example.com");
    typeInto("chat-action-form-input-subject", "Q3");
    typeInto("chat-action-form-input-body", "body");
    await act(async () => fireEvent.click(getSubmitButton()));
    await waitFor(() => {
      /* Surface the field-level error rendered by the form so we
       * know the submit response was consumed before asserting on
       * the analytics side-effects. */
      expect(screen.getByTestId("chat-action-form-field-error-to")).toBeInTheDocument();
    });
    /* Wait for both per-field analytics calls. The for-loop is
     * synchronous in the handler but the fetchWithRefresh side-
     * effects complete on subsequent microtasks. waitFor polls
     * until both lands. */
    await waitFor(() => {
      const analyticsCalls = mockFetch.mock.calls.filter((c) => c[0] === "/api/analytics");
      const merged = analyticsCalls.map((c) => c[1]?.body || "").join("\n");
      expect(merged).toContain('"field_name":"to"');
      expect(merged).toContain('"field_name":"subject"');
    });
  });
});

describe("ChatActionForm — default values pre-fill", () => {
  test("defaultValue is rendered in the input on mount", () => {
    const spec: FormSpec = {
      ...emailSpec,
      fields: [
        { name: "to", label: "To *", type: "email", required: true, defaultValue: "alice@example.com" },
        ...emailSpec.fields.slice(1),
      ],
    };
    render(<ChatActionForm spec={spec} />);
    const input = screen.getByTestId("chat-action-form-input-to") as HTMLInputElement;
    expect(input.value).toBe("alice@example.com");
  });
});
