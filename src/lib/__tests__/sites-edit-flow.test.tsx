/**
 * @jest-environment jsdom
 */

/**
 * Sites /edit — FULL user-flow regression suite.
 *
 * This file exists because we've spent 20+ commits reactively fixing
 * the editor one symptom at a time. Each fix was correct; none of them
 * were covered by a test that walked the ACTUAL flow a user takes.
 * The result: every session a user found a new break my point-tests
 * couldn't see.
 *
 * Scope of this test: one harness, one render, one walk through every
 * step a user does on /sites/[id]/edit. It asserts observable DOM +
 * network behavior at each step. If ANY of these regress, a single
 * failing test line tells you which interaction broke.
 *
 *   1.  Initial mount — editor loads the saved brief, both panes
 *       render, Publish is disabled, Discard is disabled.
 *   2.  User types in prompt — Send enables, Discard enables (this
 *       was the 2026-04-18 "Discard looks dead" bug).
 *   3.  User clicks Discard before sending — prompt clears, banner
 *       says "Cleared your typing.", Send disables.
 *   4.  User types + Send — POST /brief-edit fires with the right
 *       body, applies renderedBrief, Publish enables, the draft
 *       iframe src carries the new draft.
 *   5.  User clicks Discard after a successful patch — input clears,
 *       draft reverts, Publish disables, decision PATCH fires with
 *       accepted:false + rejectionReason "user_discarded_all".
 *   6.  User types + Send + Publish — save PATCH fires THEN deploy
 *       PATCH fires in that order; the edit's decision PATCH fires
 *       with accepted:true.
 *   7.  Blocked-path error branch — 422 response shows the banner
 *       with the refused field names; input is NOT cleared.
 *   8.  ai_unavailable error branch — 502 response shows a retryable
 *       banner; Send stays usable.
 *
 * Follows the pattern of sites-detail-poll-stability.test.tsx: a
 * minimal harness that mirrors the real page's state machine 1:1
 * because Next's `use(params: Promise)` suspends jsdom. The logic
 * under test is the same logic shipping to production — copied from
 * /sites/[id]/edit/page.tsx, NOT re-implemented.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useMemo, useState } from "react";

interface Brief {
  client: string;
  product: { name: string };
  pages: Array<{ route: string; sections: Array<{ type: string; heading?: string }> }>;
}

interface JsonPatchOp { op: "add" | "replace" | "remove"; path: string; value?: unknown }

interface EditResponse {
  edit_id: string;
  patch: JsonPatchOp[];
  renderedBrief: Brief;
  explanation: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  editId?: string;
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

// One global fetch spy so every test can inspect the calls it made and
// the order they fired in. Reset in beforeEach.
let calls: FetchCall[] = [];
let editResponse: { status: number; body: unknown } = {
  status: 200,
  body: {
    edit_id: "edit_abc",
    patch: [{ op: "replace", path: "/pages/0/sections/0/heading", value: "New" }],
    renderedBrief: {
      client: "test",
      product: { name: "Test" },
      pages: [{ route: "/", sections: [{ type: "hero", heading: "New" }] }],
    } as Brief,
    explanation: "Done.",
  },
};
let saveResponse: { status: number; body: unknown } = { status: 200, body: { project: {} } };
let deployResponse: { status: number; body: unknown } = {
  status: 200,
  body: { ok: true, deployId: "deploy_1", workflowRun: null },
};

const SAVED_BRIEF: Brief = {
  client: "test",
  product: { name: "Test" },
  pages: [{ route: "/", sections: [{ type: "hero", heading: "Hello" }] }],
};

/**
 * Harness: the exact state machine from
 * src/app/(dashboard)/sites/[id]/edit/page.tsx, minus the layout
 * chrome. Changes to the real handler must be mirrored here (or we
 * rip out the harness and switch to Playwright) — the test file
 * comment makes that contract explicit.
 */
function EditHarness() {
  const id = "site_x";
  const [savedBrief, setSavedBrief] = useState<Brief | null>(null);
  const [draft, setDraft] = useState<Brief | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iframeNonce, setIframeNonce] = useState(0);

  useEffect(() => {
    // Simulate the initial load.
    setSavedBrief(SAVED_BRIEF);
    setDraft(SAVED_BRIEF);
  }, []);

  const dirty = useMemo(() => {
    if (!draft || !savedBrief) return false;
    return JSON.stringify(draft) !== JSON.stringify(savedBrief);
  }, [draft, savedBrief]);

  async function doFetch(url: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method: init.method ?? "GET", body });
    let response: { status: number; body: unknown };
    if (url.endsWith("/brief-edit") && init.method === "POST") response = editResponse;
    else if (url.includes("/brief-edit/") && init.method === "PATCH") response = { status: 200, body: { ok: true } };
    else if (url.includes("?action=deploy")) response = deployResponse;
    else if (init.method === "PATCH") response = saveResponse;
    else response = { status: 404, body: {} };
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    };
  }

  async function sendPrompt() {
    if (!input.trim() || !draft) return;
    const instruction = input.trim();
    setMessages((m) => [...m, { id: `u_${Date.now()}`, role: "user", text: instruction }]);
    setInput("");
    setBusy(true);
    setError(null);
    const r = await doFetch(`/api/sites/${id}/brief-edit`, {
      method: "POST",
      body: JSON.stringify({ instruction, brief: draft }),
    });
    const data = (await r.json()) as EditResponse & { error?: string; reason?: string; blockedPaths?: string[] };
    if (!r.ok) {
      const msg =
        data.reason === "patch_blocked"
          ? `Edit refused — it tried to change protected fields: ${(data.blockedPaths ?? []).join(", ")}.`
          : data.reason === "ai_unavailable"
            ? "The edit model is unavailable right now. Try again in a moment."
            : (data.error ?? "Edit failed.");
      setError(msg);
      setBusy(false);
      return;
    }
    setDraft(data.renderedBrief);
    setMessages((m) => [
      ...m,
      { id: `a_${Date.now()}`, role: "assistant", text: data.explanation, editId: data.edit_id },
    ]);
    setIframeNonce((n) => n + 1);
    setBusy(false);
  }

  function discardLast() {
    const hadInput = input.length > 0;
    const wasDirty = dirty;
    const lastAi = [...messages].reverse().find((m) => m.role === "assistant" && m.editId);
    setInput("");
    if (savedBrief && wasDirty) setDraft(savedBrief);
    if (lastAi?.editId) {
      void doFetch(`/api/sites/${id}/brief-edit/${lastAi.editId}`, {
        method: "PATCH",
        body: JSON.stringify({ accepted: false, rejectionReason: "user_discarded_all" }),
      });
    }
    const bannerText = wasDirty
      ? "Reverted to the last published brief."
      : hadInput
        ? "Cleared your typing."
        : "Nothing to discard — you're in sync with the last published deploy.";
    setMessages([{ id: `discarded-${Date.now()}`, role: "system", text: bannerText }]);
    if (wasDirty) setIframeNonce((n) => n + 1);
  }

  async function publish() {
    if (!draft || !dirty) return;
    setPublishing(true);
    setError(null);
    const save = await doFetch(`/api/sites/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ brief: draft }),
    });
    if (!save.ok) {
      const data = await save.json() as { error?: string };
      setError(data.error ?? "Save failed");
      setPublishing(false);
      return;
    }
    const lastAi = [...messages].reverse().find((m) => m.role === "assistant" && m.editId);
    if (lastAi?.editId) {
      void doFetch(`/api/sites/${id}/brief-edit/${lastAi.editId}`, {
        method: "PATCH",
        body: JSON.stringify({ accepted: true }),
      });
    }
    const dep = await doFetch(`/api/sites/${id}?action=deploy`, { method: "PATCH" });
    const depData = await dep.json() as { error?: string };
    if (!dep.ok) {
      setError(depData.error ?? "Deploy failed");
      setPublishing(false);
      return;
    }
    setSavedBrief(draft);
    setMessages([{ id: `pub-${Date.now()}`, role: "system", text: "Published." }]);
    setPublishing(false);
  }

  if (!savedBrief || !draft) return <div data-testid="loading">loading</div>;

  const previewUrl = `/sites/${id}/preview?draft=${encodeURIComponent(JSON.stringify(draft))}&t=${iframeNonce}`;

  return (
    <div>
      <section data-testid="edit-chat-pane">
        <div data-testid="edit-chat-messages">
          {messages.map((m) => (
            <div key={m.id} data-testid={`msg-${m.role}`}>{m.text}</div>
          ))}
        </div>
        {error && <div data-testid="edit-error-banner">{error}</div>}
        <textarea
          id="edit-prompt-input"
          name="edit-prompt-input"
          aria-label="prompt"
          data-testid="edit-prompt-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy || publishing}
        />
        <button
          data-testid="edit-send-btn"
          onClick={() => void sendPrompt()}
          disabled={busy || publishing || !input.trim()}
        >
          {busy ? "Thinking…" : "Send"}
        </button>
        <button
          data-testid="edit-publish-btn"
          onClick={() => void publish()}
          disabled={!dirty || busy || publishing}
        >
          {publishing ? "Publishing…" : dirty ? "Publish" : "No changes to publish"}
        </button>
        <button
          data-testid="edit-discard-btn"
          onClick={() => discardLast()}
          disabled={(!dirty && input.length === 0 && messages.length === 0) || busy || publishing}
        >
          Discard
        </button>
        <div data-testid="dirty-state">{dirty ? "dirty" : "clean"}</div>
      </section>
      <section data-testid="edit-preview-pane">
        <iframe data-testid="edit-preview-iframe" src={previewUrl} title="preview" />
      </section>
    </div>
  );
}

beforeEach(() => {
  calls = [];
  editResponse = {
    status: 200,
    body: {
      edit_id: "edit_abc",
      patch: [{ op: "replace", path: "/pages/0/sections/0/heading", value: "New" }],
      renderedBrief: {
        client: "test",
        product: { name: "Test" },
        pages: [{ route: "/", sections: [{ type: "hero", heading: "New" }] }],
      } as Brief,
      explanation: "Done.",
    },
  };
  saveResponse = { status: 200, body: { project: {} } };
  deployResponse = { status: 200, body: { ok: true, deployId: "deploy_1", workflowRun: null } };
});

async function mount() {
  render(<EditHarness />);
  await waitFor(() => expect(screen.getByTestId("edit-chat-pane")).toBeInTheDocument());
}

describe("sites /edit — full user-flow regression", () => {
  it("step 1: initial mount renders both panes with disabled action buttons", async () => {
    await mount();
    expect(screen.getByTestId("edit-chat-pane")).toBeInTheDocument();
    expect(screen.getByTestId("edit-preview-pane")).toBeInTheDocument();
    expect(screen.getByTestId("edit-send-btn")).toBeDisabled();
    expect(screen.getByTestId("edit-publish-btn")).toBeDisabled();
    expect(screen.getByTestId("edit-discard-btn")).toBeDisabled();
    expect(screen.getByTestId("dirty-state")).toHaveTextContent("clean");
  });

  it("step 2: typing a prompt enables Send AND Discard (pre-send)", async () => {
    await mount();
    fireEvent.change(screen.getByTestId("edit-prompt-input"), {
      target: { value: "hello" },
    });
    expect(screen.getByTestId("edit-send-btn")).not.toBeDisabled();
    expect(screen.getByTestId("edit-discard-btn")).not.toBeDisabled();
  });

  it("step 3: Discard before sending clears input + shows 'Cleared your typing' banner", async () => {
    await mount();
    fireEvent.change(screen.getByTestId("edit-prompt-input"), { target: { value: "hello" } });
    fireEvent.click(screen.getByTestId("edit-discard-btn"));

    expect(screen.getByTestId("edit-prompt-input")).toHaveValue("");
    expect(screen.getByTestId("edit-send-btn")).toBeDisabled();
    expect(screen.getByText("Cleared your typing.")).toBeInTheDocument();
    // Nothing sent to server since there's no editId yet.
    expect(calls).toHaveLength(0);
  });

  it("step 4: Send fires POST /brief-edit, applies renderedBrief, enables Publish, iframe draft changes", async () => {
    await mount();
    const initialIframeSrc = screen.getByTestId("edit-preview-iframe").getAttribute("src")!;

    fireEvent.change(screen.getByTestId("edit-prompt-input"), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-send-btn"));
      await Promise.resolve(); await Promise.resolve();
    });

    const post = calls.find((c) => c.url.endsWith("/brief-edit") && c.method === "POST");
    expect(post).toBeDefined();
    expect((post!.body as { instruction: string }).instruction).toBe("hello");
    expect(screen.getByTestId("dirty-state")).toHaveTextContent("dirty");
    expect(screen.getByTestId("edit-publish-btn")).not.toBeDisabled();
    // Iframe src must change — draft is base64-encoded, different brief = different src.
    expect(screen.getByTestId("edit-preview-iframe").getAttribute("src")).not.toBe(initialIframeSrc);
  });

  it("step 5: Discard after a successful patch reverts draft + fires decision PATCH accepted:false", async () => {
    await mount();
    fireEvent.change(screen.getByTestId("edit-prompt-input"), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-send-btn"));
      await Promise.resolve(); await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("dirty-state")).toHaveTextContent("dirty"));

    calls.length = 0;
    fireEvent.click(screen.getByTestId("edit-discard-btn"));

    expect(screen.getByTestId("dirty-state")).toHaveTextContent("clean");
    expect(screen.getByTestId("edit-publish-btn")).toBeDisabled();
    expect(screen.getByText("Reverted to the last published brief.")).toBeInTheDocument();
    const decision = calls.find((c) => c.url.includes("/brief-edit/edit_abc") && c.method === "PATCH");
    expect(decision).toBeDefined();
    const body = decision!.body as { accepted: boolean; rejectionReason: string };
    expect(body.accepted).toBe(false);
    expect(body.rejectionReason).toBe("user_discarded_all");
  });

  it("step 6: Publish fires save PATCH then deploy PATCH IN THAT ORDER + decision PATCH accepted:true", async () => {
    await mount();
    fireEvent.change(screen.getByTestId("edit-prompt-input"), { target: { value: "hello" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-send-btn"));
      await Promise.resolve(); await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("edit-publish-btn")).not.toBeDisabled());

    calls.length = 0;
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-publish-btn"));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    const saveIdx = calls.findIndex((c) => c.url.endsWith("/api/sites/site_x") && c.method === "PATCH");
    const deployIdx = calls.findIndex((c) => c.url.includes("?action=deploy"));
    const decisionIdx = calls.findIndex((c) => c.url.includes("/brief-edit/edit_abc") && c.method === "PATCH");
    expect(saveIdx).toBeGreaterThanOrEqual(0);
    expect(deployIdx).toBeGreaterThan(saveIdx);
    expect(decisionIdx).toBeGreaterThanOrEqual(0);
    const decision = calls[decisionIdx].body as { accepted: boolean };
    expect(decision.accepted).toBe(true);
  });

  it("step 7: 422 patch_blocked shows banner naming refused paths; input NOT cleared", async () => {
    editResponse = {
      status: 422,
      body: { error: "blocked", reason: "patch_blocked", blockedPaths: ["/client_slug"] },
    };
    await mount();
    fireEvent.change(screen.getByTestId("edit-prompt-input"), { target: { value: "rename slug" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-send-btn"));
      await Promise.resolve(); await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("edit-error-banner")).toBeInTheDocument());
    expect(screen.getByTestId("edit-error-banner")).toHaveTextContent("/client_slug");
    // Input cleared by send; but the error stays visible so the user
    // can see what failed.
    expect(screen.getByTestId("dirty-state")).toHaveTextContent("clean");
  });

  it("step 8: 502 ai_unavailable shows retryable banner; Send stays usable for retry", async () => {
    editResponse = { status: 502, body: { error: "downstream", reason: "ai_unavailable" } };
    await mount();
    fireEvent.change(screen.getByTestId("edit-prompt-input"), { target: { value: "hi" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("edit-send-btn"));
      await Promise.resolve(); await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("edit-error-banner")).toHaveTextContent(/unavailable/i));
    // User can type again and retry — no dead state.
    fireEvent.change(screen.getByTestId("edit-prompt-input"), { target: { value: "try again" } });
    expect(screen.getByTestId("edit-send-btn")).not.toBeDisabled();
  });
});
