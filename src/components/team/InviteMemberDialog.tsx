"use client";

/**
 * InviteMemberDialog — modal for inviting a new team member.
 *
 * Posts to /api/team/invite (capability-gated by the route, not here).
 * On success, surfaces the accept-url so the inviter can hand-deliver
 * if email delivery is disabled (no RESEND_API_KEY) or fails.
 *
 * Closing the dialog after a successful invite resets state. The
 * parent owns the open/close. analytics fires on success.
 */

import { useState, FormEvent, useId } from "react";
import { jsonHeaders, fetchWithRefresh } from "@/lib/client-auth";

const ROLES: Array<{ value: string; label: string }> = [
  { value: "ops", label: "Ops" },
  { value: "dev", label: "Developer" },
  { value: "sales", label: "Sales" },
  { value: "hr", label: "HR" },
  { value: "evp", label: "EVP" },
  { value: "cto", label: "CTO" },
  { value: "ceo", label: "CEO" },
];

interface InviteResultRow {
  id: string;
  email: string;
  role: string;
  acceptUrl: string;
  emailDelivered: boolean;
  emailReason?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onInvited?: (inv: InviteResultRow) => void;
}

export default function InviteMemberDialog({ open, onClose, onInvited }: Props) {
  const formId = useId();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("ops");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<InviteResultRow | null>(null);
  const [copied, setCopied] = useState(false);

  if (!open) return null;

  function handleClose() {
    setEmail("");
    setRole("ops");
    setError("");
    setResult(null);
    setCopied(false);
    onClose();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (!email.includes("@")) {
      setError("Enter a valid email address.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetchWithRefresh("/api/team/invite", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ invites: [{ email: email.trim().toLowerCase(), role }] }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Could not send invite.");
        setSubmitting(false);
        return;
      }
      const row = (data.invites?.[0] ?? null) as InviteResultRow | null;
      if (!row) {
        setError("Invite created but server returned an unexpected response.");
        setSubmitting(false);
        return;
      }
      setResult(row);
      setSubmitting(false);
      onInvited?.(row);
    } catch {
      setError("Network error. Please try again.");
      setSubmitting(false);
    }
  }

  async function copyAcceptUrl() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.acceptUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can fail in secure contexts — leave the URL on screen
      // for manual copy as the fallback.
    }
  }

  return (
    <div
      data-testid="invite-member-dialog"
      role="dialog"
      aria-labelledby={`${formId}-title`}
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        className="w-full max-w-md rounded-xl border p-6"
        style={{
          background: "var(--wp-dark-surface)",
          borderColor: "var(--wp-dark-border)",
        }}
      >
        <div className="flex items-start justify-between mb-4 gap-3">
          <h2 id={`${formId}-title`} className="text-lg font-semibold" style={{ color: "var(--wp-gold)" }}>
            {result ? "Invite sent" : "Invite team member"}
          </h2>
          <button
            type="button"
            onClick={handleClose}
            data-testid="invite-dialog-close"
            aria-label="Close"
            className="text-sm px-2 py-1 rounded transition-colors"
            style={{ color: "var(--wp-text-dim)" }}
          >
            ✕
          </button>
        </div>

        {!result ? (
          <form onSubmit={handleSubmit} className="space-y-4" data-testid="invite-member-form">
            <div>
              <label htmlFor={`${formId}-email`} className="block text-sm font-medium mb-1.5" style={{ color: "var(--wp-text-dim)" }}>
                Email
              </label>
              <input
                id={`${formId}-email`}
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="invite-member-email"
                className="w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  color: "var(--wp-text)",
                }}
                placeholder="teammate@thewolfpack.agency"
              />
            </div>

            <div>
              <label htmlFor={`${formId}-role`} className="block text-sm font-medium mb-1.5" style={{ color: "var(--wp-text-dim)" }}>
                Role
              </label>
              <select
                id={`${formId}-role`}
                value={role}
                onChange={(e) => setRole(e.target.value)}
                data-testid="invite-member-role"
                className="w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors"
                style={{
                  background: "var(--wp-dark-surface2)",
                  borderColor: "var(--wp-dark-border)",
                  color: "var(--wp-text)",
                }}
              >
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>

            {error && (
              <div
                data-testid="invite-member-error"
                className="rounded-lg px-3 py-2 text-sm"
                style={{
                  background: "rgba(239, 68, 68, 0.1)",
                  color: "var(--wp-error)",
                  border: "1px solid var(--wp-error)",
                }}
              >
                {error}
              </div>
            )}

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={handleClose}
                disabled={submitting}
                className="flex-1 rounded-lg px-4 py-2 text-sm font-medium border transition-colors"
                style={{
                  background: "transparent",
                  color: "var(--wp-text-dim)",
                  borderColor: "var(--wp-dark-border)",
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting}
                data-testid="invite-member-submit"
                className="flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
                style={{
                  background: submitting ? "var(--wp-dark-surface2)" : "var(--wp-gold)",
                  color: submitting ? "var(--wp-text-muted)" : "var(--wp-dark)",
                  cursor: submitting ? "not-allowed" : "pointer",
                }}
              >
                {submitting ? "Sending…" : "Send invite"}
              </button>
            </div>
          </form>
        ) : (
          <div className="space-y-4" data-testid="invite-member-success">
            <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
              {result.emailDelivered
                ? `Invite emailed to ${result.email}. They'll set their password from the link.`
                : `Email delivery is not configured (or the send failed) — copy this link and send it to ${result.email} so they can finish setting up their account.`}
            </p>
            <div
              className="rounded-lg p-3 text-xs break-all border"
              style={{
                background: "var(--wp-dark-surface2)",
                borderColor: "var(--wp-dark-border)",
                color: "var(--wp-text-dim)",
                fontFamily: "var(--font-mono, monospace)",
              }}
              data-testid="invite-accept-url"
            >
              {result.acceptUrl}
            </div>
            {result.emailReason && !result.emailDelivered && (
              <p className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                Email status: {result.emailReason}
              </p>
            )}
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={copyAcceptUrl}
                data-testid="invite-copy-url"
                className="flex-1 rounded-lg px-4 py-2 text-sm font-medium border transition-colors"
                style={{
                  background: "transparent",
                  color: copied ? "var(--wp-success)" : "var(--wp-text-dim)",
                  borderColor: copied ? "var(--wp-success)" : "var(--wp-dark-border)",
                }}
              >
                {copied ? "Copied" : "Copy link"}
              </button>
              <button
                type="button"
                onClick={handleClose}
                data-testid="invite-done"
                className="flex-1 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
                style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
