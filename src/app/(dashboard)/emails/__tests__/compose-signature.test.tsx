/** @jest-environment jsdom */
 
/**
 * Compose-pane signature behaviour:
 *   1) The "Signature" toolbar dropdown lists the user's saved signatures
 *      and inserts the chosen one into the body.
 *   2) When the user has a default signature AND opens a fresh composer
 *      with an empty body, the body is pre-filled with `\n\n${defaultSig}`.
 *   3) Templates / replies that already populate the body are NOT
 *      pre-filled (the fresh-only guard).
 *
 * The reply/forward branch — signature inserted ABOVE the quoted block
 * — is a pure-function test against `insertSignatureAboveQuotedBlock`
 * inside src/lib/__tests__/email-signatures.test.ts. Replies in this app
 * happen inside EmailReader.tsx (a plain textarea) where the sender is
 * the user; this test file covers the new-email composer.
 */
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
  getInstinctUser: () => ({ id: "u-me", role: "ceo", email: "me@x", name: "Tester" }),
}));

const mockEmitInsight = jest.fn();
jest.mock("@/lib/insights/emit", () => ({
  emitInsight: (e: unknown) => mockEmitInsight(e),
}));

import { act, fireEvent, render, screen } from "@testing-library/react";
import EmailsPage from "@/app/(dashboard)/emails/page";

interface MockResponse {
  ok?: boolean;
  status?: number;
  json: () => Promise<any>;
}
function ok(body: any, status = 200): MockResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const TEMPLATES = { templates: [] };
const INBOX_DEFAULT = { messages: [], nextSkip: null, unreadCount: 0 };

const SIG_LIST_DEFAULT = {
  signatures: [
    {
      id: "sig-1",
      label: "Default",
      body: "Nick — CTO\nWolfpack Agency",
      isDefault: true,
    },
    {
      id: "sig-2",
      label: "Short",
      body: "Nick",
      isDefault: false,
    },
  ],
};

const SIG_LIST_EMPTY = { signatures: [] };

const SIG_LIST_NO_DEFAULT = {
  signatures: [
    { id: "sig-3", label: "Long", body: "Nick — CTO", isDefault: false },
  ],
};

function makeRouter(sigsBody: any) {
  return (url: string): MockResponse => {
    if (url.startsWith("/api/email-signatures")) return ok(sigsBody);
    if (url.startsWith("/api/emails/inbox")) return ok(INBOX_DEFAULT);
    if (url.startsWith("/api/emails")) return ok(TEMPLATES);
    if (url.startsWith("/api/microsoft?action=emails-from"))
      return ok({ emails: [] });
    if (url.startsWith("/api/calendar/range")) return ok({ events: [] });
    return ok({});
  };
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockEmitInsight.mockReset();
  window.sessionStorage.clear();
  window.localStorage.clear();
  try {
    window.history.replaceState({}, "", "/emails");
  } catch {
    /* noop */
  }
  if (typeof (document as any).execCommand !== "function") {
    (document as any).execCommand = () => true;
  }
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: 1400,
  });
});

async function flushPromises() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

async function openComposer() {
  const newBtn = await screen.findByTestId("inbox-new-email");
  fireEvent.click(newBtn);
  await flushPromises();
}

describe("Composer — Signature dropdown", () => {
  it("renders a Signature toolbar button when the composer is open", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) =>
      Promise.resolve(makeRouter(SIG_LIST_DEFAULT)(url)),
    );
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();
    expect(screen.getByTestId("signature-menu-toggle")).toBeInTheDocument();
  });

  it("dropdown lists each saved signature with its label", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) =>
      Promise.resolve(makeRouter(SIG_LIST_DEFAULT)(url)),
    );
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();
    fireEvent.click(screen.getByTestId("signature-menu-toggle"));
    expect(screen.getByTestId("signature-menu")).toBeInTheDocument();
    expect(screen.getByTestId("signature-menu-item-sig-1")).toBeInTheDocument();
    expect(screen.getByTestId("signature-menu-item-sig-2")).toBeInTheDocument();
    expect(screen.getByTestId("signature-menu-manage")).toHaveAttribute(
      "href",
      "/settings#email-signatures",
    );
  });

  it("clicking a signature inserts it into the composer body", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) =>
      Promise.resolve(makeRouter(SIG_LIST_DEFAULT)(url)),
    );
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();

    /* The default signature has already pre-filled the body — clearing
       it here so the assertion targets the explicit insertion path. */
    const body = screen.getByLabelText("Email body") as HTMLDivElement;
    body.innerHTML = "";
    fireEvent.input(body);

    fireEvent.click(screen.getByTestId("signature-menu-toggle"));
    fireEvent.click(screen.getByTestId("signature-menu-item-sig-2"));
    await flushPromises();

    /* Body now contains the chosen signature ("Nick"). The escape +
       <br> conversion in plainTextToHtml means a single-line "Nick"
       is preserved verbatim. */
    expect((body.innerHTML || body.textContent || "").includes("Nick")).toBe(true);

    /* Analytics: signature_inserted insight emitted. */
    const calls = mockEmitInsight.mock.calls.map((c) => c[0]);
    expect(
      calls.some(
        (e: any) =>
          e?.action === "signature_inserted" &&
          e?.target === "sig-2" &&
          e?.payload?.signature_id === "sig-2",
      ),
    ).toBe(true);
  });

  it("shows an empty state when the user has no signatures saved", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) =>
      Promise.resolve(makeRouter(SIG_LIST_EMPTY)(url)),
    );
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();
    fireEvent.click(screen.getByTestId("signature-menu-toggle"));
    expect(screen.getByText(/no signatures saved/i)).toBeInTheDocument();
  });
});

describe("Composer — default signature pre-fill", () => {
  it("pre-fills the body with the default signature on a fresh compose", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) =>
      Promise.resolve(makeRouter(SIG_LIST_DEFAULT)(url)),
    );
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();
    /* Allow the post-mount signature-prefill effect to run. */
    await flushPromises();

    const body = screen.getByLabelText("Email body") as HTMLDivElement;
    /* The pre-fill HTML is the escaped + <br>-converted form of
       `\n\n${defaultSignature.body}`. We assert on the visible text. */
    expect(body.textContent ?? "").toMatch(/Nick — CTO/);
  });

  it("does NOT pre-fill when the user has no default signature", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) =>
      Promise.resolve(makeRouter(SIG_LIST_NO_DEFAULT)(url)),
    );
    render(<EmailsPage />);
    await flushPromises();
    await openComposer();
    await flushPromises();
    const body = screen.getByLabelText("Email body") as HTMLDivElement;
    expect((body.textContent ?? "").trim()).toBe("");
  });

  it("does NOT pre-fill when the body is non-empty (template-inserted, reply, etc.)", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) =>
      Promise.resolve(makeRouter(SIG_LIST_DEFAULT)(url)),
    );
    /* Seed sessionStorage with an existing draft so the composer hydrates
       with a non-empty body — mirrors the reply/forward path where the
       reader has already populated the draft. */
    window.sessionStorage.setItem(
      "mail.compose.draft",
      JSON.stringify({
        to: ["jane@example.com"],
        cc: [],
        bcc: [],
        subject: "Re: project",
        body: "Reply text already typed",
      }),
    );

    render(<EmailsPage />);
    await flushPromises();
    await openComposer();
    await flushPromises();

    const body = screen.getByLabelText("Email body") as HTMLDivElement;
    /* The default signature must NOT have been auto-prepended. */
    expect(body.textContent ?? "").not.toMatch(/Nick — CTO/);
    expect(body.textContent ?? "").toMatch(/Reply text already typed/);
  });
});

// ---------------------------------------------------------------------------
// Reply / forward branch — EmailReader
// ---------------------------------------------------------------------------
//
// The EmailReader pre-fills its reply textarea with "\n\n${defaultSig}" so
// the user can type ABOVE the signature. Microsoft Graph's reply endpoint
// appends the quoted-original block below the user's body, putting the
// signature in exactly the right spot (above the quoted block).

const READER_MESSAGE = {
  message: {
    id: "row-1",
    subject: "Re: Onboarding deck",
    from: { name: "Jane Doe", email: "jane@example.com" },
    toRecipients: [],
    ccRecipients: [],
    receivedDateTime: new Date().toISOString(),
    bodyContentType: "text",
    bodyContent: "Body",
    bodyPreview: "Body",
    webLink: "",
  },
};

describe("EmailReader — reply/forward signature insertion", () => {
  function makeReaderRouter(sigsBody: any) {
    return (url: string): MockResponse => {
      if (url === "/api/mail/row-1") return ok(READER_MESSAGE);
      if (url.startsWith("/api/email-signatures")) return ok(sigsBody);
      return ok({});
    };
  }

  it("pre-fills the reply textarea with the default signature on first focus", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) =>
      Promise.resolve(makeReaderRouter(SIG_LIST_DEFAULT)(url)),
    );

    /* Direct EmailReader render — bypasses the page shell. */
    const { default: EmailReader } = await import(
      "@/app/(dashboard)/emails/EmailReader"
    );
    render(<EmailReader id="row-1" onClose={() => {}} />);
    await flushPromises();

    const textarea = (await screen.findByTestId(
      "email-reader-reply-input",
    )) as HTMLTextAreaElement;

    /* Lazy load: empty until user focuses the textarea. */
    expect(textarea.value).toBe("");
    fireEvent.focus(textarea);
    await flushPromises();

    /* "\n\n${defaultSignature.body}" — assertion is on .value, not text.
       Spec: insert ABOVE the quoted-original block. Microsoft Graph
       appends the quoted block below the user's bodyText so the
       signature ends up immediately above the quote. */
    expect(textarea.value).toMatch(/Nick — CTO/);
    expect(textarea.value.startsWith("\n\n")).toBe(true);
  });

  it("does NOT pre-fill when the user has no default signature", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) =>
      Promise.resolve(makeReaderRouter(SIG_LIST_NO_DEFAULT)(url)),
    );
    const { default: EmailReader } = await import(
      "@/app/(dashboard)/emails/EmailReader"
    );
    render(<EmailReader id="row-1" onClose={() => {}} />);
    await flushPromises();
    const textarea = (await screen.findByTestId(
      "email-reader-reply-input",
    )) as HTMLTextAreaElement;
    fireEvent.focus(textarea);
    await flushPromises();
    expect(textarea.value).toBe("");
  });

  it("does NOT pre-fill if the user has typed content before the fetch completes", async () => {
    mockFetchWithRefresh.mockImplementation((url: string) =>
      Promise.resolve(makeReaderRouter(SIG_LIST_DEFAULT)(url)),
    );
    const { default: EmailReader } = await import(
      "@/app/(dashboard)/emails/EmailReader"
    );
    render(<EmailReader id="row-1" onClose={() => {}} />);
    await flushPromises();
    const textarea = (await screen.findByTestId(
      "email-reader-reply-input",
    )) as HTMLTextAreaElement;
    /* User types BEFORE focus / before the lazy fetch completes. */
    fireEvent.change(textarea, { target: { value: "Half-typed text" } });
    fireEvent.focus(textarea);
    await flushPromises();
    /* Pre-fill is gated on `reply.length === 0` — typed content wins. */
    expect(textarea.value).toBe("Half-typed text");
  });
});
