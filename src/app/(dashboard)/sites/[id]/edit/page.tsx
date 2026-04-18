"use client";

/**
 * Sites — split-screen prompt-driven editor.
 *
 * Left pane: chat + diff of the last change; right pane: live iframe of
 * the brief rendered by /sites/[id]/preview. No deploys fire on prompt —
 * drafts update the iframe via a same-origin localStorage bridge + a
 * cache-busting reload. User clicks Publish to run the existing save +
 * deploy flow.
 *
 * Every action emits analytics (`trackEvent` server-side from the API;
 * the client also pings `/api/track` on mount, publish, discard). NO
 * orphan UI.
 */

import { useEffect, useMemo, useRef, useState, use } from "react";
import { useRouter } from "next/navigation";
import {
  authHeaders,
  jsonHeaders,
  fetchWithRefresh,
} from "@/lib/client-auth";
import type { Brief } from "@/components/sites/BriefForm";

interface SiteProject {
  id: string;
  client_slug: string;
  display_name: string;
  brief: Brief;
  status: string;
  preview_url: string | null;
}

interface JsonPatchOp {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
}

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
  patch?: JsonPatchOp[];
  editId?: string;
  timestamp: number;
}

const DRAFT_STORAGE_KEY = (projectId: string) => `instinct_draft_${projectId}`;

// ---------------------------------------------------------------------------
// Extracted pure helpers (unit-testable without mounting the page).
// `use(params: Promise)` suspends in jsdom; RTL never ticks. Helpers live
// here so the error-mapping contract + dirty computation can be pinned in
// jest without a full render. Full-flow coverage sits in the Playwright
// E2E spec (tests/e2e/sites-edit-flow.spec.ts).
// ---------------------------------------------------------------------------

export interface BriefEditErrorPayload {
  error?: string;
  reason?: string;
  blockedPaths?: string[];
}

export function mapEditError(data: BriefEditErrorPayload): string {
  const reason = data.reason ?? "unknown";
  if (reason === "patch_blocked") {
    return `Edit refused — it tried to change protected fields: ${(data.blockedPaths ?? []).join(", ")}.`;
  }
  if (reason === "ai_unavailable") {
    return "The edit model is unavailable right now. Try again in a moment.";
  }
  return data.error ?? "Edit failed.";
}

export function briefsDiffer(a: Brief | null, b: Brief | null): boolean {
  if (!a || !b) return false;
  return JSON.stringify(a) !== JSON.stringify(b);
}

function trackClient(eventName: string, metadata: Record<string, unknown>) {
  // POST to /api/analytics (the real endpoint) with auth + {event, metadata}.
  // Was /api/track which doesn't exist — produced silent 404s in the
  // console on every funnel event. Uses jsonHeaders() so the user's
  // token attaches and the server can scope analytics to their user_id.
  if (typeof window === "undefined") return;
  const token =
    localStorage.getItem("instinct_token") ??
    localStorage.getItem("apex_token");
  if (!token) return;
  fetch("/api/analytics", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      event: eventName,
      metadata: {
        ...metadata,
        page: window.location.pathname,
      },
    }),
  }).catch(() => {
    /* non-fatal — analytics must never break UX */
  });
}

export default function SiteEditPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();

  const [project, setProject] = useState<SiteProject | null>(null);
  const [savedBrief, setSavedBrief] = useState<Brief | null>(null);
  const [draft, setDraft] = useState<Brief | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [iframeNonce, setIframeNonce] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Auth gate — redirect to login if no token.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const token = localStorage.getItem("instinct_token") ?? localStorage.getItem("apex_token");
    if (!token) {
      window.location.href = `/login?next=/sites/${id}/edit`;
    }
  }, [id]);

  // Load the saved project.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetchWithRefresh(`/api/sites/${id}`, { headers: authHeaders() });
        if (!r.ok) {
          setError(`Could not load site (HTTP ${r.status}).`);
          return;
        }
        const data = (await r.json()) as { project: SiteProject };
        setProject(data.project);
        setSavedBrief(data.project.brief);
        // Try to restore any in-progress draft from localStorage; else start from saved.
        const stored = localStorage.getItem(DRAFT_STORAGE_KEY(id));
        if (stored) {
          try {
            const parsed = JSON.parse(stored) as Brief;
            setDraft(parsed);
            setMessages([
              {
                id: "restore",
                role: "system",
                text: "Restored an in-progress draft from your last session. Publish or Discard to reset.",
                timestamp: Date.now(),
              },
            ]);
          } catch {
            setDraft(data.project.brief);
          }
        } else {
          setDraft(data.project.brief);
        }
        trackClient("site.edit_opened", { project_id: id });
      } catch (e) {
        setError((e as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Persist draft to localStorage + nudge iframe on every change.
  useEffect(() => {
    if (!draft) return;
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY(id), JSON.stringify(draft));
    } catch {
      // storage quota — non-fatal; iframe falls back to saved brief
    }
    // Push to iframe via postMessage (fast path). Also bump nonce to reload
    // iframe — belt-and-suspenders in case the preview page hasn't wired
    // up the listener yet.
    try {
      iframeRef.current?.contentWindow?.postMessage(
        { type: "instinct:brief-update", brief: draft },
        window.location.origin,
      );
    } catch {
      /* non-fatal */
    }
  }, [draft, id]);

  const dirty = useMemo(() => {
    if (!draft || !savedBrief) return false;
    return JSON.stringify(draft) !== JSON.stringify(savedBrief);
  }, [draft, savedBrief]);

  async function sendPrompt() {
    if (!input.trim() || !draft) return;
    const instruction = input.trim();
    const userMsgId = `u_${Date.now()}`;
    setMessages((m) => [
      ...m,
      { id: userMsgId, role: "user", text: instruction, timestamp: Date.now() },
    ]);
    setInput("");
    setBusy(true);
    setError(null);
    try {
      const r = await fetchWithRefresh(`/api/sites/${id}/brief-edit`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ instruction, brief: draft }),
      });
      const data = (await r.json()) as EditResponse & {
        error?: string;
        reason?: string;
        blockedPaths?: string[];
      };
      if (!r.ok) {
        const reason = data.reason ?? "unknown";
        const msg =
          reason === "patch_blocked"
            ? `Edit refused — it tried to change protected fields: ${(data.blockedPaths ?? []).join(", ")}.`
            : reason === "ai_unavailable"
              ? "The edit model is unavailable right now. Try again in a moment."
              : (data.error ?? "Edit failed.");
        setMessages((m) => [
          ...m,
          {
            id: `e_${Date.now()}`,
            role: "assistant",
            text: msg,
            timestamp: Date.now(),
          },
        ]);
        setError(msg);
        return;
      }
      setDraft(data.renderedBrief);
      setMessages((m) => [
        ...m,
        {
          id: `a_${Date.now()}`,
          role: "assistant",
          text: data.explanation || "Applied your change.",
          patch: data.patch,
          editId: data.edit_id,
          timestamp: Date.now(),
        },
      ]);
      setIframeNonce((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function discardLast() {
    // Discard is what the user reaches for when they want to undo their
    // in-progress work. That "work" can be any of three things:
    //   - unsaved typing in the prompt input (common, what every user
    //     tries first)
    //   - an accumulated draft that diverges from the saved brief
    //   - a session full of assistant messages they don't want to keep
    // Pre-2026-04-18 we only handled #2 and bailed early if !savedBrief
    // or !dirty, so clicking Discard after just typing in the prompt
    // looked like a broken button. It now clears all three.
    const hadInput = input.length > 0;
    const wasDirty = dirty;
    const lastAi = [...messages].reverse().find((m) => m.role === "assistant" && m.editId);

    setInput("");
    if (savedBrief && wasDirty) {
      setDraft(savedBrief);
    }
    if (wasDirty) {
      localStorage.removeItem(DRAFT_STORAGE_KEY(id));
    }

    // Tell the backend the last edit was rejected so the learning loop
    // captures "user said no to this patch". Non-fatal — analytics and
    // the UI state always fire.
    if (lastAi?.editId) {
      fetchWithRefresh(`/api/sites/${id}/brief-edit/${lastAi.editId}`, {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({ accepted: false, rejectionReason: "user_discarded_all" }),
      }).catch(() => {
        /* non-fatal */
      });
    }

    const bannerText = wasDirty
      ? "Reverted to the last published brief."
      : hadInput
        ? "Cleared your typing."
        : "Nothing to discard — you're in sync with the last published deploy.";
    setMessages([
      {
        id: `discarded-${Date.now()}`,
        role: "system",
        text: bannerText,
        timestamp: Date.now(),
      },
    ]);
    trackClient("site.edit_discarded", {
      project_id: id,
      had_input: hadInput,
      had_dirty_draft: wasDirty,
      had_edit_id: !!lastAi?.editId,
    });
    if (wasDirty) setIframeNonce((n) => n + 1);
  }

  async function publish() {
    if (!draft || !dirty) return;
    setPublishing(true);
    setError(null);
    try {
      // 1. Save the brief via the existing PATCH handler
      const saveRes = await fetchWithRefresh(`/api/sites/${id}`, {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({ brief: draft }),
      });
      if (!saveRes.ok) {
        const data = await saveRes.json().catch(() => ({}));
        throw new Error(data.error ?? `Save failed (HTTP ${saveRes.status}).`);
      }
      // 2. Mark the last AI edit as accepted so learning sees the positive.
      const lastAi = [...messages].reverse().find((m) => m.role === "assistant" && m.editId);
      if (lastAi?.editId) {
        fetchWithRefresh(`/api/sites/${id}/brief-edit/${lastAi.editId}`, {
          method: "PATCH",
          headers: jsonHeaders(),
          body: JSON.stringify({ accepted: true }),
        }).catch(() => {
          /* non-fatal */
        });
      }
      // 3. Fire the deploy
      const depRes = await fetchWithRefresh(`/api/sites/${id}?action=deploy`, {
        method: "PATCH",
        headers: authHeaders(),
      });
      const depData = await depRes.json().catch(() => ({}));
      if (!depRes.ok) {
        throw new Error(depData.error ?? `Deploy failed (HTTP ${depRes.status}).`);
      }
      trackClient("site.edit_published", {
        project_id: id,
        deploy_id: (depData as { deployId?: string }).deployId,
        edits_in_session: messages.filter((m) => m.role === "assistant" && m.editId).length,
      });
      // 4. Reset — saved == draft now
      setSavedBrief(draft);
      localStorage.removeItem(DRAFT_STORAGE_KEY(id));
      setMessages([
        {
          id: `pub_${Date.now()}`,
          role: "system",
          text: "Published. Deploy started — preview will rebuild in ~3 minutes.",
          timestamp: Date.now(),
        },
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPublishing(false);
    }
  }

  if (!project || !draft) {
    return (
      <main style={{ padding: 40, color: "var(--wp-fg, #e6e6e6)" }}>
        {error ? <p style={{ color: "#e07070" }}>{error}</p> : <p>Loading editor…</p>}
      </main>
    );
  }

  // Preview URL: encode the current draft as base64 so the iframe renders
  // the in-memory state without a save/deploy round-trip. Falls back to
  // the saved brief if the payload is too large (>256KB cap on the
  // preview page); for realistic briefs this never hits.
  const previewUrl = (() => {
    try {
      const encoded =
        typeof btoa === "function"
          ? btoa(unescape(encodeURIComponent(JSON.stringify(draft))))
          : Buffer.from(JSON.stringify(draft), "utf-8").toString("base64");
      if (encoded.length > 256 * 1024) {
        // Draft is enormous — fall back to saved brief.
        return `/sites/${id}/preview?t=${iframeNonce}`;
      }
      return `/sites/${id}/preview?draft=${encodeURIComponent(encoded)}&t=${iframeNonce}`;
    } catch {
      return `/sites/${id}/preview?t=${iframeNonce}`;
    }
  })();

  return (
    <main
      style={{
        display: "grid",
        gridTemplateColumns: "420px 1fr",
        height: "calc(100vh - 64px)",
        gap: 0,
        color: "var(--wp-fg, #e6e6e6)",
        background: "var(--wp-bg, #0f1115)",
      }}
    >
      {/* LEFT — chat + publish controls */}
      <section
        style={{
          borderRight: "1px solid rgba(255,255,255,0.08)",
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
        }}
        data-testid="edit-chat-pane"
      >
        <header style={{ padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
          <div style={{ fontSize: 12, opacity: 0.6 }}>{project.client_slug}</div>
          <h1 style={{ fontSize: 18, fontWeight: 600, margin: "4px 0 0" }}>
            {project.display_name}
          </h1>
        </header>

        <div
          style={{ flex: 1, overflowY: "auto", padding: "12px 20px" }}
          data-testid="edit-chat-messages"
        >
          {messages.length === 0 ? (
            <div style={{ opacity: 0.6, fontSize: 14, padding: "24px 0" }}>
              Describe any change you want to make. The preview updates on the right.
              Example: <em>&quot;Change the hero headline to &apos;Season One&apos;.&quot;</em>
            </div>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                style={{
                  padding: "8px 12px",
                  margin: "4px 0",
                  borderRadius: 8,
                  background:
                    m.role === "user"
                      ? "rgba(80, 140, 220, 0.08)"
                      : m.role === "assistant"
                        ? "rgba(80, 200, 120, 0.06)"
                        : "rgba(255,255,255,0.04)",
                  border:
                    m.role === "user"
                      ? "1px solid rgba(80, 140, 220, 0.25)"
                      : m.role === "assistant"
                        ? "1px solid rgba(80, 200, 120, 0.2)"
                        : "1px solid rgba(255,255,255,0.08)",
                  fontSize: 14,
                }}
              >
                <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 2 }}>
                  {m.role === "user" ? "You" : m.role === "assistant" ? "Assistant" : "System"}
                </div>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
                {m.patch && m.patch.length > 0 && (
                  <details style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                    <summary style={{ cursor: "pointer" }}>{m.patch.length} change(s)</summary>
                    <ul style={{ margin: "6px 0 0 0", paddingLeft: 18 }}>
                      {m.patch.map((op, i) => (
                        <li key={i}>
                          <code>{op.op}</code> <code>{op.path}</code>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ))
          )}
        </div>

        <div
          style={{
            padding: 16,
            borderTop: "1px solid rgba(255,255,255,0.08)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {error && (
            <div
              style={{
                padding: "8px 12px",
                background: "rgba(220, 80, 80, 0.08)",
                border: "1px solid rgba(220, 80, 80, 0.3)",
                borderRadius: 6,
                fontSize: 12,
                color: "#e07070",
              }}
              data-testid="edit-error-banner"
            >
              {error}
            </div>
          )}
          <label htmlFor="edit-prompt-input" style={{ position: "absolute", left: "-9999px" }}>
            Describe a change to the site
          </label>
          <textarea
            id="edit-prompt-input"
            name="edit-prompt-input"
            data-testid="edit-prompt-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void sendPrompt();
              }
            }}
            placeholder="Describe a change. Cmd/Ctrl+Enter to send."
            rows={3}
            disabled={busy || publishing}
            aria-label="Describe a change to the site"
            style={{
              width: "100%",
              padding: 10,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 6,
              color: "inherit",
              fontSize: 14,
              fontFamily: "inherit",
              resize: "vertical",
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              data-testid="edit-send-btn"
              onClick={() => void sendPrompt()}
              disabled={busy || publishing || !input.trim()}
              style={{
                flex: 1,
                padding: "10px 12px",
                background: busy ? "rgba(255,255,255,0.04)" : "var(--wp-accent, #f3b841)",
                color: busy ? "var(--wp-fg)" : "#111",
                border: "none",
                borderRadius: 6,
                fontWeight: 600,
                cursor: busy ? "default" : "pointer",
              }}
            >
              {busy ? "Thinking…" : "Send"}
            </button>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              data-testid="edit-publish-btn"
              onClick={() => void publish()}
              disabled={!dirty || busy || publishing}
              style={{
                flex: 1,
                padding: "8px 12px",
                background: dirty ? "rgba(80, 200, 120, 0.16)" : "rgba(255,255,255,0.04)",
                border: dirty ? "1px solid rgba(80, 200, 120, 0.4)" : "1px solid rgba(255,255,255,0.12)",
                color: dirty ? "#6dcf85" : "rgba(255,255,255,0.45)",
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                cursor: dirty && !publishing ? "pointer" : "default",
              }}
            >
              {publishing ? "Publishing…" : dirty ? "Publish" : "No changes to publish"}
            </button>
            <button
              data-testid="edit-discard-btn"
              onClick={() => void discardLast()}
              // Enabled when there's ANYTHING to discard — unsaved
              // typing in the prompt OR a dirty draft OR assistant
              // messages from the current session. Leaving it disabled
              // when the user typed "hello" in the prompt but hadn't
              // sent it made the button look dead.
              disabled={(!dirty && input.length === 0 && messages.length === 0) || busy || publishing}
              style={{
                padding: "8px 12px",
                background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.12)",
                color: "inherit",
                borderRadius: 6,
                fontSize: 13,
                cursor: dirty && !publishing ? "pointer" : "default",
              }}
            >
              Discard
            </button>
          </div>
          <div style={{ fontSize: 11, opacity: 0.5 }}>
            {dirty ? "Draft — not yet published." : "In sync with last published deploy."}
          </div>
        </div>
      </section>

      {/* RIGHT — live preview iframe */}
      <section style={{ position: "relative", minWidth: 0 }} data-testid="edit-preview-pane">
        <iframe
          ref={iframeRef}
          key={iframeNonce /* force re-render when we bump */}
          src={previewUrl}
          title="Live preview"
          style={{
            width: "100%",
            height: "100%",
            border: "none",
            background: "#fff",
          }}
          data-testid="edit-preview-iframe"
          /*
           * DON'T set `sandbox` here. Chrome warns when an iframe has
           * BOTH `allow-same-origin` AND `allow-scripts` because the
           * sandboxed content can script its way out of the sandbox —
           * which is the classic bypass pattern. The preview page
           * lives on the same origin (wolfpack-instinct.vercel.app)
           * and frame-ancestors 'self' already gates who can embed
           * it, so a sandbox here is defense-theater, not defense-in-
           * depth.
           */
        />
      </section>
    </main>
  );
}
