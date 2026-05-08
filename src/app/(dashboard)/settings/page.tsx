"use client";

import { useState, useEffect, useCallback } from "react";
import { getInstinctToken, getInstinctUser, authHeaders, fetchWithRefresh } from "@/lib/client-auth";
import {
  startMicrosoftConnect,
  startQuickbooksConnect,
  connectPlaud as connectPlaudHelper,
} from "@/lib/integrations/connect";
import { sanitizeHtml } from "@/lib/html-sanitize";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UserInfo {
  name: string;
  email: string;
  role: string;
}

interface MicrosoftStatus {
  connected: boolean;
  email?: string;
  connectedAt?: string;
}

interface QuickBooksStatus {
  connected: boolean;
  companyName?: string;
  connectedAt?: string;
}

interface PlaudStatus {
  connected: boolean;
  configured: boolean;
  connectedBy?: string;
  connectedByName?: string;
  connectedAt?: string;
}

interface UsageWindow {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_hits: number;
  ai_calls: number;
}

interface UsageResponse {
  user_id_hint: string;
  lifetime: UsageWindow;
  last_30_days: UsageWindow;
  generated_at: string;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionCard({
  title,
  id,
  children,
}: {
  title: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      id={id}
      className="rounded-lg border p-5"
      style={{ background: "var(--wp-dark-surface)", borderColor: "var(--wp-dark-border)" }}
    >
      <h2 className="text-sm font-semibold mb-4" style={{ color: "var(--wp-gold)" }}>
        {title}
      </h2>
      {children}
    </div>
  );
}

interface EmailSignature {
  id: string;
  label: string;
  body: string;
  bodyFormat?: "text" | "html";
  isDefault: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface DetectedHtmlSignaturePreview {
  html: string;
  text: string;
  sampledCount: number;
  matchedCount: number;
  confidence: number;
}

/**
 * Sandboxed HTML preview for an email signature. Uses srcdoc + sandbox
 * so the embedded HTML can show its inlined logos and links without
 * being able to run scripts or read the parent's auth state. Height
 * auto-fits in a `ResizeObserver` round-trip via postMessage on load.
 */
function SignatureHtmlPreview({
  html,
  testId,
}: {
  html: string;
  testId?: string;
}) {
  const [height, setHeight] = useState<number>(180);

  /* Wrap the user's HTML in a minimal document with a sane base font
     and word-wrap so long URLs don't push out the iframe horizontally.
     The signature HTML is fully parser-sanitized via DOMPurify before
     it reaches the iframe. The `sandbox=""` attribute is still set as
     defense in depth, but parser-based sanitization is what blocks the
     mutation-XSS attack class (e.g. `<scr<script>ipt>`) that CodeQL
     flagged js/incomplete-multi-character-sanitization on the prior
     regex strip. */
  const safeHtml = sanitizeHtml(html);
  const srcdoc = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:8px;font-family:Arial,sans-serif;font-size:14px;color:#222;background:#fff;word-wrap:break-word}img{max-width:100%}a{color:#0a66c2}</style></head><body>${safeHtml}<script>parent.postMessage({type:'instinct-sig-preview-h',h:document.body.scrollHeight+16},'*')<\/script></body></html>`;

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      // The preview iframe is loaded from a `srcDoc` so its postMessage
      // origin is the literal string "null". Reject anything else
      // outright (CodeQL: js/missing-origin-check). We additionally
      // require the source to be our own iframe contentWindow.
      if (e.origin !== "null" && e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; h?: number } | undefined;
      if (data?.type === "instinct-sig-preview-h" && typeof data.h === "number") {
        setHeight(Math.min(Math.max(data.h, 80), 600));
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  return (
    <iframe
      data-testid={testId}
      title="Signature preview"
      srcDoc={srcdoc}
      sandbox=""
      style={{
        width: "100%",
        height,
        border: "1px solid var(--wp-dark-border)",
        borderRadius: 4,
        background: "#fff",
      }}
    />
  );
}

function EmailSignaturesCard() {
  const [signatures, setSignatures] = useState<EmailSignature[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState<string>("");
  const [newBody, setNewBody] = useState<string>("");
  const [newIsDefault, setNewIsDefault] = useState<boolean>(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState<string>("");
  const [editBody, setEditBody] = useState<string>("");
  /* Outlook-import workflow state. The detected HTML is held only in
     component state until the user clicks Save, at which point we POST
     it as a new signature with bodyFormat='html'. */
  const [detected, setDetected] =
    useState<DetectedHtmlSignaturePreview | null>(null);
  const [detectedLabel, setDetectedLabel] = useState<string>("Outlook signature");
  const [detectedIsDefault, setDetectedIsDefault] = useState<boolean>(false);
  const [importHint, setImportHint] = useState<string | null>(null);

  const fetchSignatures = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/email-signatures", {
        headers: authHeaders(),
      });
      if (res.ok) {
        const data = (await res.json()) as { signatures?: EmailSignature[] };
        setSignatures(Array.isArray(data.signatures) ? data.signatures : []);
      } else if (res.status === 401) {
        window.location.href = "/login";
        return;
      } else {
        setError("Couldn't load signatures.");
      }
    } catch {
      setError("Network error loading signatures.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchSignatures();
  }, [fetchSignatures]);

  async function createSig() {
    if (!newLabel.trim() || !newBody.trim()) {
      setError("Label and body are required.");
      return;
    }
    setBusy("create");
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/email-signatures", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          label: newLabel.trim(),
          body: newBody.trim(),
          isDefault: newIsDefault,
        }),
      });
      if (res.ok) {
        setNewLabel("");
        setNewBody("");
        setNewIsDefault(false);
        await fetchSignatures();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "Failed to create signature.");
      }
    } catch {
      setError("Network error creating signature.");
    }
    setBusy(null);
  }

  async function patchSig(id: string, patch: Record<string, unknown>) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/email-signatures/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      if (res.ok) {
        await fetchSignatures();
        setEditingId(null);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "Failed to update signature.");
      }
    } catch {
      setError("Network error updating signature.");
    }
    setBusy(null);
  }

  async function deleteSig(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/email-signatures/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: authHeaders(),
        },
      );
      if (res.ok) {
        await fetchSignatures();
      } else {
        setError("Failed to delete signature.");
      }
    } catch {
      setError("Network error deleting signature.");
    }
    setBusy(null);
  }

  function startEdit(sig: EmailSignature) {
    setEditingId(sig.id);
    setEditLabel(sig.label);
    setEditBody(sig.body);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditLabel("");
    setEditBody("");
  }

  async function detectFromOutlook() {
    setBusy("detect");
    setError(null);
    setImportHint(null);
    try {
      const res = await fetchWithRefresh(
        "/api/email-signatures/detect-from-outlook",
        {
          method: "POST",
          headers: { ...authHeaders(), "Content-Type": "application/json" },
          body: JSON.stringify({ format: "html" }),
        },
      );
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (data?.ok && data.signature?.html) {
        setDetected({
          html: data.signature.html,
          text: data.signature.text ?? "",
          sampledCount: data.signature.sampledCount ?? 0,
          matchedCount: data.signature.matchedCount ?? 0,
          confidence: data.signature.confidence ?? 0,
        });
      } else if (data?.code === "scope_missing") {
        setImportHint(
          "Reconnect Microsoft 365 to grant the Mail.Read scope, then try again.",
        );
      } else if (data?.code === "not_connected") {
        setImportHint(
          "Connect Microsoft 365 in the integrations card above to import.",
        );
      } else if (data?.code === "no_sent_mail") {
        setImportHint(
          "No sent messages found in your Outlook — send one with your signature, then retry.",
        );
      } else if (data?.code === "no_signature_detected") {
        setImportHint(
          "Couldn't detect a signature in your recent sent messages. Add one below manually.",
        );
      } else {
        setError(data?.message || "Detection failed.");
      }
    } catch {
      setError("Network error detecting signature.");
    }
    setBusy(null);
  }

  function discardDetected() {
    setDetected(null);
    setDetectedLabel("Outlook signature");
    setDetectedIsDefault(false);
    setImportHint(null);
  }

  async function saveDetected() {
    if (!detected) return;
    if (!detectedLabel.trim()) {
      setError("Label is required for the imported signature.");
      return;
    }
    setBusy("save-detected");
    setError(null);
    try {
      const res = await fetchWithRefresh("/api/email-signatures", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          label: detectedLabel.trim(),
          body: detected.html,
          bodyFormat: "html",
          isDefault: detectedIsDefault,
        }),
      });
      if (res.ok) {
        discardDetected();
        await fetchSignatures();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "Failed to save imported signature.");
      }
    } catch {
      setError("Network error saving imported signature.");
    }
    setBusy(null);
  }

  return (
    <div data-testid="settings-email-signatures" className="space-y-4">
      {error && (
        <p
          role="alert"
          className="text-xs"
          style={{ color: "var(--wp-warning)" }}
        >
          {error}
        </p>
      )}
      <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
        Saved signatures appear in the /emails composer toolbar. Mark one as
        default to have it pre-fill every fresh email.
      </p>

      {loading ? (
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
          Loading signatures…
        </p>
      ) : signatures.length === 0 ? (
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
          No signatures yet. Add one below.
        </p>
      ) : (
        <ul className="space-y-3" data-testid="signatures-list">
          {signatures.map((sig) => {
            const isEditing = editingId === sig.id;
            return (
              <li
                key={sig.id}
                className="rounded border p-3"
                style={{
                  borderColor: "var(--wp-dark-border)",
                  background: "var(--wp-dark)",
                }}
                data-testid={`signature-row-${sig.id}`}
              >
                {isEditing ? (
                  <div className="space-y-2">
                    <input
                      type="text"
                      aria-label="Edit signature label"
                      data-testid={`signature-edit-label-${sig.id}`}
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      className="w-full px-2 py-1 text-sm rounded border"
                      style={{
                        background: "var(--wp-dark-surface2)",
                        borderColor: "var(--wp-dark-border)",
                        color: "var(--wp-text)",
                      }}
                    />
                    <textarea
                      aria-label="Edit signature body"
                      data-testid={`signature-edit-body-${sig.id}`}
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value)}
                      rows={4}
                      className="w-full px-2 py-1 text-sm rounded border"
                      style={{
                        background: "var(--wp-dark-surface2)",
                        borderColor: "var(--wp-dark-border)",
                        color: "var(--wp-text)",
                        fontFamily: "inherit",
                      }}
                    />
                    <div className="flex gap-2">
                      <button
                        type="button"
                        data-testid={`signature-save-${sig.id}`}
                        disabled={busy === sig.id}
                        onClick={() =>
                          patchSig(sig.id, {
                            label: editLabel,
                            body: editBody,
                          })
                        }
                        className="px-3 py-1 rounded text-xs font-medium"
                        style={{
                          background: "var(--wp-gold)",
                          color: "var(--wp-dark)",
                        }}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="px-3 py-1 rounded text-xs"
                        style={{
                          background: "var(--wp-dark-surface2)",
                          color: "var(--wp-text)",
                          border: "1px solid var(--wp-dark-border)",
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p
                        className="text-sm font-medium"
                        style={{ color: "var(--wp-text)" }}
                      >
                        {sig.label}
                        {sig.isDefault && (
                          <span
                            className="ml-2 text-xs px-1.5 py-0.5 rounded"
                            style={{
                              background: "var(--wp-gold)",
                              color: "var(--wp-dark)",
                            }}
                          >
                            default
                          </span>
                        )}
                      </p>
                    </div>
                    {sig.bodyFormat === "html" ? (
                      <SignatureHtmlPreview
                        html={sig.body}
                        testId={`signature-body-html-${sig.id}`}
                      />
                    ) : (
                      <pre
                        className="text-xs whitespace-pre-wrap"
                        style={{
                          color: "var(--wp-text-dim)",
                          fontFamily: "inherit",
                        }}
                      >
                        {sig.body}
                      </pre>
                    )}
                    <div className="flex gap-2 flex-wrap">
                      <button
                        type="button"
                        data-testid={`signature-edit-${sig.id}`}
                        onClick={() => startEdit(sig)}
                        className="px-3 py-1 rounded text-xs"
                        style={{
                          background: "var(--wp-dark-surface2)",
                          color: "var(--wp-text)",
                          border: "1px solid var(--wp-dark-border)",
                        }}
                      >
                        Edit
                      </button>
                      {!sig.isDefault && (
                        <button
                          type="button"
                          data-testid={`signature-set-default-${sig.id}`}
                          disabled={busy === sig.id}
                          onClick={() =>
                            patchSig(sig.id, { isDefault: true })
                          }
                          className="px-3 py-1 rounded text-xs"
                          style={{
                            background: "var(--wp-dark-surface2)",
                            color: "var(--wp-gold)",
                            border: "1px solid var(--wp-gold)",
                          }}
                        >
                          Set as default
                        </button>
                      )}
                      <button
                        type="button"
                        data-testid={`signature-delete-${sig.id}`}
                        disabled={busy === sig.id}
                        onClick={() => deleteSig(sig.id)}
                        className="px-3 py-1 rounded text-xs"
                        style={{
                          background: "transparent",
                          color: "var(--wp-error)",
                          border: "1px solid var(--wp-error)",
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Outlook import block. Pulls the user's animated/HTML signature
          straight out of their most recent sent message — preserves
          images, links, and formatting that the manual textarea below
          would strip. */}
      <div
        className="rounded border p-3 space-y-2"
        style={{
          borderColor: "var(--wp-dark-border)",
          background: "var(--wp-dark)",
        }}
        data-testid="signature-import-block"
      >
        <div className="flex items-center justify-between gap-2">
          <p
            className="text-xs font-medium"
            style={{ color: "var(--wp-text)" }}
          >
            Import from Outlook
          </p>
          {!detected && (
            <button
              type="button"
              data-testid="signature-import-btn"
              disabled={busy === "detect"}
              onClick={detectFromOutlook}
              className="px-3 py-1 rounded text-xs font-medium"
              style={{
                background: "var(--wp-gold)",
                color: "var(--wp-dark)",
              }}
            >
              {busy === "detect"
                ? "Detecting…"
                : "Detect my Outlook signature"}
            </button>
          )}
        </div>
        <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
          Pulls the trailing block of your most recent sent message,
          including images and links. Review before saving.
        </p>
        {importHint && (
          <p
            data-testid="signature-import-hint"
            className="text-xs"
            style={{ color: "var(--wp-warning)" }}
          >
            {importHint}
          </p>
        )}
        {detected && (
          <div className="space-y-2" data-testid="signature-detected-preview">
            <p className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
              Detected from {detected.sampledCount} recent sent message
              {detected.sampledCount === 1 ? "" : "s"}
              {detected.confidence > 0
                ? ` · ${(detected.confidence * 100).toFixed(0)}% suffix-match confidence`
                : ""}
            </p>
            <SignatureHtmlPreview
              html={detected.html}
              testId="signature-detected-iframe"
            />
            <input
              type="text"
              aria-label="Imported signature label"
              data-testid="signature-detected-label"
              value={detectedLabel}
              onChange={(e) => setDetectedLabel(e.target.value)}
              className="w-full px-2 py-1 text-sm rounded border"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text)",
              }}
            />
            <label
              className="flex items-center gap-2 text-xs"
              style={{ color: "var(--wp-text-dim)" }}
            >
              <input
                type="checkbox"
                data-testid="signature-detected-default"
                checked={detectedIsDefault}
                onChange={(e) => setDetectedIsDefault(e.target.checked)}
              />
              Make this my default signature
            </label>
            <div className="flex gap-2">
              <button
                type="button"
                data-testid="signature-detected-save"
                disabled={busy === "save-detected"}
                onClick={saveDetected}
                className="px-3 py-1 rounded text-xs font-medium"
                style={{
                  background: "var(--wp-gold)",
                  color: "var(--wp-dark)",
                }}
              >
                {busy === "save-detected" ? "Saving…" : "Save signature"}
              </button>
              <button
                type="button"
                data-testid="signature-detected-discard"
                onClick={discardDetected}
                className="px-3 py-1 rounded text-xs"
                style={{
                  background: "transparent",
                  color: "var(--wp-text)",
                  border: "1px solid var(--wp-dark-border)",
                }}
              >
                Discard
              </button>
            </div>
          </div>
        )}
      </div>

      <div
        className="rounded border p-3 space-y-2"
        style={{
          borderColor: "var(--wp-dark-border)",
          background: "var(--wp-dark)",
        }}
        data-testid="signature-create-form"
      >
        <p className="text-xs font-medium" style={{ color: "var(--wp-text)" }}>
          Add a signature
        </p>
        <input
          type="text"
          aria-label="New signature label"
          data-testid="signature-new-label"
          placeholder="Label (e.g. Default, Short, Demo)"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          className="w-full px-2 py-1 text-sm rounded border"
          style={{
            background: "var(--wp-dark-surface2)",
            borderColor: "var(--wp-dark-border)",
            color: "var(--wp-text)",
          }}
        />
        <textarea
          aria-label="New signature body"
          data-testid="signature-new-body"
          placeholder={"Nick Homyk — CTO\nWolfpack Agency"}
          value={newBody}
          onChange={(e) => setNewBody(e.target.value)}
          rows={4}
          className="w-full px-2 py-1 text-sm rounded border"
          style={{
            background: "var(--wp-dark-surface2)",
            borderColor: "var(--wp-dark-border)",
            color: "var(--wp-text)",
            fontFamily: "inherit",
          }}
        />
        <label
          className="flex items-center gap-2 text-xs"
          style={{ color: "var(--wp-text-dim)" }}
        >
          <input
            type="checkbox"
            data-testid="signature-new-default"
            checked={newIsDefault}
            onChange={(e) => setNewIsDefault(e.target.checked)}
          />
          Make this my default signature
        </label>
        <button
          type="button"
          data-testid="signature-create-btn"
          disabled={busy === "create"}
          onClick={createSig}
          className="px-3 py-1 rounded text-xs font-medium"
          style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
        >
          {busy === "create" ? "Saving…" : "Add signature"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [microsoftStatus, setMicrosoftStatus] = useState<MicrosoftStatus>({ connected: false });
  const [quickbooksStatus, setQuickbooksStatus] = useState<QuickBooksStatus>({ connected: false });
  const [plaudStatus, setPlaudStatus] = useState<PlaudStatus>({ connected: false, configured: false });
  const [loadingMicrosoft, setLoadingMicrosoft] = useState(true);
  const [loadingQuickbooks, setLoadingQuickbooks] = useState(true);
  const [loadingPlaud, setLoadingPlaud] = useState(true);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [loadingUsage, setLoadingUsage] = useState(true);
  const [briefingEnabled, setBriefingEnabled] = useState(true);
  const [emailNotifications, setEmailNotifications] = useState(true);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  function getToken() {
    return getInstinctToken() || "";
  }

  function decodeUser(): UserInfo | null {
    const stored = getInstinctUser<{ name?: string; email?: string; role?: string }>();
    if (stored) {
      return { name: stored.name || "", email: stored.email || "", role: stored.role || "" };
    }
    const token = getToken();
    if (!token) return null;
    try {
      const payload = JSON.parse(atob(token.split(".")[1]));
      return { name: payload.name || payload.sub || "", email: payload.email || "", role: payload.role || "" };
    } catch {
      return null;
    }
  }

  const fetchMicrosoftStatus = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/microsoft?action=status", {
        headers: authHeaders(),
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (res.ok) {
        const data = await res.json();
        setMicrosoftStatus({
          connected: data.connected || false,
          email: data.email,
          connectedAt: data.connectedAt,
        });
      }
    } catch {
      // Non-fatal
    }
    setLoadingMicrosoft(false);
  }, []);

  const fetchPlaudStatus = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/integrations/plaud?action=status", {
        headers: authHeaders(),
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (res.ok) {
        const data = await res.json();
        setPlaudStatus({
          connected: data.connected || false,
          configured: data.configured || false,
          connectedBy: data.connectedBy,
          connectedByName: data.displayName,
          connectedAt: data.connectedAt,
        });
      }
    } catch {
      // Non-fatal
    }
    setLoadingPlaud(false);
  }, []);

  const fetchUsage = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/usage", { headers: authHeaders() });
      if (res.ok) {
        const data = (await res.json()) as UsageResponse;
        setUsage(data);
      }
    } catch {
      /* non-fatal */
    }
    setLoadingUsage(false);
  }, []);

  const fetchQuickbooksStatus = useCallback(async () => {
    try {
      const res = await fetchWithRefresh("/api/quickbooks?action=status", {
        headers: authHeaders(),
      });
      if (res.status === 401) {
        window.location.href = "/login";
        return;
      }
      if (res.status === 403) {
        // Not authorized for QB — hide it
        setLoadingQuickbooks(false);
        return;
      }
      if (res.ok) {
        const data = await res.json();
        setQuickbooksStatus({
          connected: data.connection?.connected || false,
          companyName: data.companyInfo?.companyName || data.connection?.companyName,
          connectedAt: data.connection?.lastSync,
        });
      }
    } catch {
      // Non-fatal
    }
    setLoadingQuickbooks(false);
  }, []);

  useEffect(() => {
    // Decode user
    const u = decodeUser();
    setUser(u);

    // Load preferences from localStorage. Dual-read for one release to
    // catch users whose browser missed the boot-time migrator in
    // client-auth.ts → migrateLegacyApexKeys().
    const briefing =
      localStorage.getItem("instinct_briefing_enabled") ??
      localStorage.getItem("apex_briefing_enabled");
    if (briefing !== null) setBriefingEnabled(briefing === "true");
    const notifs =
      localStorage.getItem("instinct_email_notifications") ??
      localStorage.getItem("apex_email_notifications");
    if (notifs !== null) setEmailNotifications(notifs === "true");

    // Track page view
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "settings" } }),
    }).catch(() => {});

    // Fetch integration statuses
    fetchMicrosoftStatus();
    fetchQuickbooksStatus();
    fetchPlaudStatus();
    fetchUsage();
  }, [fetchMicrosoftStatus, fetchQuickbooksStatus, fetchPlaudStatus, fetchUsage]);

  const [connectError, setConnectError] = useState<string | null>(null);

  async function connectMicrosoft() {
    setConnectError(null);
    const result = await startMicrosoftConnect();
    if (!result.ok) {
      setConnectError(result.error);
    }
  }

  async function disconnectMicrosoft() {
    setDisconnecting("microsoft");
    setConnectError(null);
    try {
      const res = await fetchWithRefresh("/api/microsoft?action=disconnect", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disconnect" }),
      });
      if (res.ok) {
        setMicrosoftStatus({ connected: false });
      } else {
        setConnectError("Failed to disconnect Microsoft. Please try again.");
      }
    } catch {
      setConnectError("Network error while disconnecting Microsoft.");
    }
    setDisconnecting(null);
  }

  async function connectQuickbooks() {
    await startQuickbooksConnect();
  }

  async function disconnectQuickbooks() {
    setDisconnecting("quickbooks");
    try {
      const res = await fetchWithRefresh("/api/quickbooks?action=disconnect", {
        method: "POST",
        headers: authHeaders(),
      });
      if (res.ok) {
        setQuickbooksStatus({ connected: false });
      }
    } catch {
      // Non-fatal
    }
    setDisconnecting(null);
  }

  async function connectPlaud() {
    setConnectError(null);
    const result = await connectPlaudHelper(plaudStatus.configured);
    if (result.ok) {
      await fetchPlaudStatus();
    } else {
      setConnectError(result.error);
    }
  }

  async function disconnectPlaud() {
    setDisconnecting("plaud");
    try {
      const res = await fetchWithRefresh("/api/integrations/plaud", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disconnect" }),
      });
      if (res.ok) {
        setPlaudStatus({ connected: false, configured: plaudStatus.configured });
      }
    } catch {
      // Non-fatal
    }
    setDisconnecting(null);
  }

  function toggleBriefing() {
    const next = !briefingEnabled;
    setBriefingEnabled(next);
    localStorage.setItem("instinct_briefing_enabled", String(next));
  }

  function toggleEmailNotifications() {
    const next = !emailNotifications;
    setEmailNotifications(next);
    localStorage.setItem("instinct_email_notifications", String(next));
  }

  function fmtDate(d: string): string {
    try {
      return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } catch {
      return d;
    }
  }

  const isCeo = user?.role === "ceo" || user?.role === "evp";

  if (!user) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading...</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>Settings</h1>
        <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim)" }}>
          Manage your profile, integrations, and preferences
        </p>
      </div>

      {/* Token Usage */}
      <SectionCard title="Token usage">
        {loadingUsage ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
            Loading usage…
          </p>
        ) : !usage ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
            Usage data unavailable.
          </p>
        ) : (
          <div data-testid="settings-usage" className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p
                  className="text-xs uppercase tracking-wide"
                  style={{ color: "var(--wp-text-muted)" }}
                >
                  Last 30 days
                </p>
                <p
                  className="text-2xl font-semibold mt-1"
                  style={{ color: "var(--wp-text)" }}
                  data-testid="settings-usage-30d-total"
                >
                  {usage.last_30_days.total_tokens.toLocaleString()}
                </p>
                <p
                  className="text-xs mt-1"
                  style={{ color: "var(--wp-text-dim)" }}
                >
                  tokens • {usage.last_30_days.ai_calls} AI calls •{" "}
                  {usage.last_30_days.cache_hits} cache hits
                </p>
              </div>
              <div>
                <p
                  className="text-xs uppercase tracking-wide"
                  style={{ color: "var(--wp-text-muted)" }}
                >
                  Lifetime
                </p>
                <p
                  className="text-2xl font-semibold mt-1"
                  style={{ color: "var(--wp-text)" }}
                  data-testid="settings-usage-lifetime-total"
                >
                  {usage.lifetime.total_tokens.toLocaleString()}
                </p>
                <p
                  className="text-xs mt-1"
                  style={{ color: "var(--wp-text-dim)" }}
                >
                  tokens • {usage.lifetime.ai_calls} AI calls •{" "}
                  {usage.lifetime.cache_hits} cache hits
                </p>
              </div>
            </div>
            <p
              className="text-xs"
              style={{ color: "var(--wp-text-muted)" }}
            >
              Cache hits cost zero tokens. The Wolfpack Assistant routes
              calendar, meeting, goal, and financial questions through
              deterministic tools first — those also cost zero tokens.
            </p>
          </div>
        )}
      </SectionCard>

      {/* Profile */}
      <SectionCard title="Profile">
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center text-lg font-bold shrink-0"
              style={{ background: "var(--wp-dark-surface2)", color: "var(--wp-gold)" }}
            >
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="text-base font-medium" style={{ color: "var(--wp-text)" }}>{user.name}</p>
              <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>{user.email}</p>
              <span
                className="inline-block text-xs px-1.5 py-0.5 rounded font-medium mt-1"
                style={{
                  background: "var(--wp-gold)20",
                  color: "var(--wp-gold)",
                }}
              >
                {user.role.toUpperCase()}
              </span>
            </div>
          </div>
        </div>
      </SectionCard>

      {/* Email signatures */}
      <SectionCard title="Email signatures" id="email-signatures">
        <EmailSignaturesCard />
      </SectionCard>

      {/* Microsoft 365 Integration */}
      <SectionCard title="Microsoft 365">
        {loadingMicrosoft ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Checking connection...</p>
        ) : microsoftStatus.connected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: "var(--wp-success)" }}
              />
              <span className="text-sm font-medium" style={{ color: "var(--wp-success)" }}>Connected</span>
            </div>
            {microsoftStatus.email && (
              <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
                Account: <span style={{ color: "var(--wp-text)" }}>{microsoftStatus.email}</span>
              </p>
            )}
            {microsoftStatus.connectedAt && (
              <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
                Connected: {fmtDate(microsoftStatus.connectedAt)}
              </p>
            )}
            <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
              Calendar events in your morning briefing, important email highlights, meeting prep context
            </p>
            <button
              onClick={disconnectMicrosoft}
              disabled={disconnecting === "microsoft"}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors border"
              style={{ borderColor: "var(--wp-error)", color: "var(--wp-error)" }}
            >
              {disconnecting === "microsoft" ? "Disconnecting..." : "Disconnect"}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
              Connect your Microsoft 365 account to unlock personalized features for your daily workflow.
            </p>
            <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
              Calendar events in your morning briefing, important email highlights, meeting prep context
            </p>
            <button
              onClick={connectMicrosoft}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
              style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
            >
              Connect Microsoft 365
            </button>
            {connectError && (
              <p className="text-xs mt-2" style={{ color: "var(--wp-warning)" }}>{connectError}</p>
            )}
          </div>
        )}
      </SectionCard>

      {/* QuickBooks Integration (CEO only) */}
      {isCeo && (
        <SectionCard title="QuickBooks">
          {loadingQuickbooks ? (
            <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Checking connection...</p>
          ) : quickbooksStatus.connected ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <div
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: "var(--wp-success)" }}
                />
                <span className="text-sm font-medium" style={{ color: "var(--wp-success)" }}>Connected</span>
              </div>
              {quickbooksStatus.companyName && (
                <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
                  Company: <span style={{ color: "var(--wp-text)" }}>{quickbooksStatus.companyName}</span>
                </p>
              )}
              {quickbooksStatus.connectedAt && (
                <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
                  Last synced: {fmtDate(quickbooksStatus.connectedAt)}
                </p>
              )}
              <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                Financial reports, P&amp;L, balance sheet, cash flow, invoices, and payments
              </p>
              <button
                onClick={disconnectQuickbooks}
                disabled={disconnecting === "quickbooks"}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors border"
                style={{ borderColor: "var(--wp-error)", color: "var(--wp-error)" }}
              >
                {disconnecting === "quickbooks" ? "Disconnecting..." : "Disconnect"}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
                Connect your QuickBooks Online account to see financial dashboards and reports.
              </p>
              <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                Financial reports, P&amp;L, balance sheet, cash flow, invoices, and payments
              </p>
              <button
                onClick={connectQuickbooks}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
              >
                Connect QuickBooks
              </button>
            </div>
          )}
        </SectionCard>
      )}

      {/* Plaud (meeting transcripts, org-shared) */}
      <SectionCard title="Plaud — Meeting Transcripts">
        {loadingPlaud ? (
          <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Checking connection...</p>
        ) : plaudStatus.connected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div
                className="w-2 h-2 rounded-full shrink-0"
                style={{ background: "var(--wp-success)" }}
              />
              <span className="text-sm font-medium" style={{ color: "var(--wp-success)" }}>Connected</span>
            </div>
            {plaudStatus.connectedByName && (
              <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
                Connected by: <span style={{ color: "var(--wp-text)" }}>{plaudStatus.connectedByName}</span>
              </p>
            )}
            {plaudStatus.connectedAt && (
              <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
                Connected: {fmtDate(plaudStatus.connectedAt)}
              </p>
            )}
            <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
              Meeting recordings from Plaud are ingested into the team knowledge base. Every team member can browse them on the Meetings page, and the Wolfpack Assistant can answer questions about meeting content with zero AI tokens.
            </p>
            <button
              onClick={disconnectPlaud}
              disabled={disconnecting === "plaud"}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors border"
              style={{ borderColor: "var(--wp-error)", color: "var(--wp-error)" }}
            >
              {disconnecting === "plaud" ? "Disconnecting..." : "Disconnect"}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
              Connect Plaud so meeting recordings flow into the team knowledge base. This is an organization-shared connection — only one person on the team needs to connect it.
            </p>
            <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
              Setup: register the webhook URL <code>{`/api/integrations/plaud/webhook`}</code> in the Plaud Developer Portal, then click Connect.
            </p>
            {!plaudStatus.configured && (
              <p className="text-xs" style={{ color: "var(--wp-warning)" }}>
                Not configured: PLAUD_API_KEY and PLAUD_WEBHOOK_SECRET must be set in the production environment first.
              </p>
            )}
            <button
              onClick={connectPlaud}
              disabled={!plaudStatus.configured}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
            >
              Connect Plaud
            </button>
            {connectError && (
              <p className="text-xs mt-2" style={{ color: "var(--wp-warning)" }}>{connectError}</p>
            )}
          </div>
        )}
      </SectionCard>

      {/* Preferences */}
      <SectionCard title="Preferences">
        <div className="space-y-4">
          {/* Morning Briefing Toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium" style={{ color: "var(--wp-text)" }}>Morning Briefing</p>
              <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                Get a daily summary of your calendar, emails, and team activity
              </p>
            </div>
            <button
              onClick={toggleBriefing}
              className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors"
              style={{ background: briefingEnabled ? "var(--wp-gold)" : "var(--wp-dark-surface2)" }}
              role="switch"
              aria-checked={briefingEnabled}
            >
              <span
                className="pointer-events-none inline-block h-5 w-5 rounded-full shadow transition-transform"
                style={{
                  background: "var(--wp-dark)",
                  transform: briefingEnabled ? "translateX(1.25rem)" : "translateX(0)",
                }}
              />
            </button>
          </div>

          {/* Email Notifications Toggle */}
          <div
            className="flex items-center justify-between pt-4 border-t"
            style={{ borderColor: "var(--wp-dark-border)" }}
          >
            <div>
              <p className="text-sm font-medium" style={{ color: "var(--wp-text)" }}>Email Notifications</p>
              <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                Receive email alerts for important updates and mentions
              </p>
            </div>
            <button
              onClick={toggleEmailNotifications}
              className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors"
              style={{ background: emailNotifications ? "var(--wp-gold)" : "var(--wp-dark-surface2)" }}
              role="switch"
              aria-checked={emailNotifications}
            >
              <span
                className="pointer-events-none inline-block h-5 w-5 rounded-full shadow transition-transform"
                style={{
                  background: "var(--wp-dark)",
                  transform: emailNotifications ? "translateX(1.25rem)" : "translateX(0)",
                }}
              />
            </button>
          </div>
        </div>
      </SectionCard>
    </div>
  );
}
