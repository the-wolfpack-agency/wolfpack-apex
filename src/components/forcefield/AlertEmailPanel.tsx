"use client";

/**
 * The alert-address panel on the Forcefield client dashboard: see where alerts
 * go, change the address (a new confirmation email is sent), resend the
 * confirmation, or remove it. Authorized by the tenant ingest token
 * (x-forcefield-token) the dashboard already holds; raw fetch is correct (no
 * apex session), listed in the no-raw-api-fetch exceptions.
 */
import { useCallback, useEffect, useState } from "react";
import { GlassPanel, StatusPill } from "@/components/console";

interface Notify { email: string | null; status: "pending" | "confirmed" | "unsubscribed" | null; confirmedAt: string | null; restricted?: boolean }

const ERRORS: Record<string, string> = {
  invalid_request: "Enter a valid email address.",
  not_allowed: "This address cannot receive Forcefield alerts yet. Use an address on an approved domain.",
  rate_limited: "Too many confirmation emails in the last hour. Try again later.",
};

export function AlertEmailPanel({ token, site }: { token: string; site: string }) {
  const [notify, setNotify] = useState<Notify | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/forcefield/alert-email", { headers: { "x-forcefield-token": token }, cache: "no-store" });
      if (!res.ok) { setState("error"); return; }
      const body = (await res.json()) as { notify: Notify };
      setNotify(body.notify);
      setState("ok");
    } catch {
      setState("error");
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (email: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/forcefield/alert-email", {
        method: "PUT",
        headers: { "x-forcefield-token": token, "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; delivered?: boolean };
      if (res.ok) {
        setEditing(false);
        setMessage({ tone: "ok", text: body.delivered === false ? `Saved. The confirmation email to ${email} could not be sent yet; use Resend.` : `Confirmation email sent to ${email}. Click the link in it to turn alerts on.` });
        await load();
      } else {
        setMessage({ tone: "error", text: ERRORS[body.error ?? ""] ?? "Could not save just now. Please try again." });
      }
    } catch {
      setMessage({ tone: "error", text: "Could not save just now. Please try again." });
    }
    setBusy(false);
  }, [token, load]);

  const remove = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/forcefield/alert-email", { method: "DELETE", headers: { "x-forcefield-token": token } });
      if (res.ok) {
        setMessage({ tone: "ok", text: "Alert email removed. Forcefield will not email anyone about this site." });
        await load();
      } else {
        setMessage({ tone: "error", text: "Could not remove just now. Please try again." });
      }
    } catch {
      setMessage({ tone: "error", text: "Could not remove just now. Please try again." });
    }
    setBusy(false);
  }, [token, load]);

  const status = notify?.status ?? null;
  const pill = status === "confirmed"
    ? <StatusPill status="live" tone="success" label="Alerts on" testId="ff-alert-status" />
    : status === "pending"
      ? <StatusPill status="queued" tone="warning" label="Waiting for confirmation" testId="ff-alert-status" />
      : <StatusPill status="queued" label={status === "unsubscribed" ? "Unsubscribed" : "No alert email"} testId="ff-alert-status" />;

  return (
    <GlassPanel testId="ff-alert-email" padded title="Alert email" subtitle={`Where Forcefield sends alerts and the daily summary for ${site}.`}>
      {state === "loading" && <p className="mt-3 text-sm" style={{ color: "var(--wp-muted, #9aa0a6)" }}>Loading...</p>}
      {state === "error" && <p data-testid="ff-alert-error" className="mt-3 text-sm" style={{ color: "#f87171" }}>Could not load your alert settings just now.</p>}
      {state === "ok" && (
        <div className="mt-3">
          <div className="flex flex-wrap items-center gap-3">
            {pill}
            {notify?.email && <span data-testid="ff-alert-address" className="text-sm">{notify.email}</span>}
          </div>
          {editing ? (
            <form
              className="mt-3 flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => { e.preventDefault(); if (input.trim()) void save(input.trim()); }}
            >
              <input
                data-testid="ff-alert-input" type="email" required value={input} onChange={(e) => setInput(e.target.value)}
                placeholder="you@company.com" autoComplete="email"
                className="flex-1 rounded-md border px-3 py-2 text-sm"
                style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.12)", color: "var(--wp-ink, #e8eaed)" }}
              />
              <button data-testid="ff-alert-save" type="submit" disabled={busy} className="rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50" style={{ background: "var(--wp-gold, #e8b528)", color: "#0b0d11" }}>
                {busy ? "Saving..." : "Save and send confirmation"}
              </button>
              <button type="button" onClick={() => setEditing(false)} className="text-xs underline" style={{ color: "var(--wp-muted, #9aa0a6)" }}>Cancel</button>
            </form>
          ) : (
            <div className="mt-3 flex flex-wrap gap-3 text-xs">
              <button data-testid="ff-alert-change" type="button" className="underline" onClick={() => { setInput(notify?.email ?? ""); setEditing(true); }}>
                {notify?.email ? "Change address" : "Add an alert email"}
              </button>
              {status === "pending" && notify?.email && (
                <button data-testid="ff-alert-resend" type="button" className="underline" disabled={busy} onClick={() => void save(notify.email as string)}>Resend confirmation</button>
              )}
              {status === "unsubscribed" && notify?.email && (
                <button data-testid="ff-alert-resubscribe" type="button" className="underline" disabled={busy} onClick={() => void save(notify.email as string)}>Turn email back on</button>
              )}
              {notify?.email && (
                <button data-testid="ff-alert-remove" type="button" className="underline" style={{ color: "#f87171" }} disabled={busy} onClick={() => void remove()}>Remove</button>
              )}
            </div>
          )}
          {message && (
            <p data-testid="ff-alert-message" className="mt-3 text-sm" style={{ color: message.tone === "ok" ? "#34d399" : "#f87171" }}>{message.text}</p>
          )}
        </div>
      )}
    </GlassPanel>
  );
}
