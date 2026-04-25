"use client";

/**
 * porsche-classes / setup wizard.
 *
 * Three-step page that lets a non-technical operator (Alicia) configure
 * the Porsche-classes automation from end to end without touching env
 * vars or code:
 *
 *   Step 1 — Connect Outlook (Microsoft Graph token check)
 *   Step 2 — Tell us where the reports come from (sender allow-list)
 *   Step 3 — Where should we save class summaries? (SharePoint folder URL)
 *
 * Each step renders one of three states:
 *   ✓ Done       — green check, no further action
 *   ! Needs you  — yellow warning, action button visible
 *   ✗ Problem    — red x, plain-language error
 *
 * No jargon. Buttons say what they do ("Save and verify") not what they
 * are ("Submit"). Errors are full sentences, not codes.
 *
 * Auth: unauthenticated visitors are redirected to /login?next=<path>
 * BEFORE any blank content can render (per the dashboard convention).
 */

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";
import { startMicrosoftConnect } from "@/lib/integrations/connect";

interface InboxFilters {
  sender_match: string[];
  subject_match: string[];
}

interface SharepointPayload {
  site_id: string;
  drive_id: string;
  path: string;
}

interface ConfigResponse {
  inbox_filters: InboxFilters;
  sharepoint: SharepointPayload | null;
  status: {
    graph_connected: boolean;
    inbox_filter_set: boolean;
    sharepoint_set: boolean;
    anthropic_set: boolean;
  };
}

type StepState = "ok" | "warn" | "error";

function rerouteToLogin() {
  if (typeof window === "undefined") return;
  const next = encodeURIComponent(window.location.pathname);
  window.location.href = `/login?next=${next}`;
}

/**
 * Status pill — the small green / yellow / red badge each step renders.
 * Plain language only ("Done" / "Needs you" / "Problem"); the icon is
 * decorative, screen-readers get the label.
 */
function StatusPill({ state }: { state: StepState }) {
  const styles: Record<
    StepState,
    { background: string; color: string; label: string; icon: string }
  > = {
    ok: {
      background: "rgba(80,175,110,0.18)",
      color: "rgb(120,210,150)",
      label: "Done",
      icon: "✓",
    },
    warn: {
      background: "rgba(229,180,69,0.18)",
      color: "rgb(229,180,69)",
      label: "Needs you",
      icon: "!",
    },
    error: {
      background: "rgba(232,123,123,0.18)",
      color: "rgb(232,123,123)",
      label: "Problem",
      icon: "✗",
    },
  };
  const s = styles[state];
  return (
    <span
      data-testid={`status-pill-${state}`}
      role="status"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.35rem",
        padding: "0.2rem 0.55rem",
        borderRadius: 999,
        fontSize: "0.78rem",
        fontWeight: 600,
        background: s.background,
        color: s.color,
      }}
    >
      <span aria-hidden>{s.icon}</span>
      <span>{s.label}</span>
    </span>
  );
}

/**
 * Card wrapper used by all three steps. Keeps the visual rhythm of the
 * page consistent without any per-step style fork.
 */
function StepCard({
  step,
  title,
  state,
  description,
  children,
}: {
  step: number;
  title: string;
  state: StepState;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section
      data-testid={`step-${step}`}
      style={{
        background: "var(--wp-card)",
        border: "1px solid var(--wp-border)",
        borderRadius: 8,
        padding: "1.2rem 1.4rem",
        marginBottom: "1.1rem",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.8rem",
          marginBottom: "0.4rem",
        }}
      >
        <h2 style={{ margin: 0, fontSize: "1.05rem" }}>
          <span style={{ color: "var(--wp-text-dim)", marginRight: "0.4rem" }}>
            Step {step}
          </span>
          {title}
        </h2>
        <StatusPill state={state} />
      </header>
      <p style={{ margin: "0 0 0.9rem", color: "var(--wp-text-dim)", fontSize: "0.9rem" }}>
        {description}
      </p>
      {children}
    </section>
  );
}

export default function PorscheClassesSetupPage() {
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /* Step 2 form state — two simple inputs. We pre-fill from whatever
     senders look like an email address in the existing config so the
     operator can edit, not retype. */
  const [surveySender, setSurveySender] = useState("");
  const [cognitoSender, setCognitoSender] = useState("");
  const [savingStep2, setSavingStep2] = useState(false);
  const [step2Saved, setStep2Saved] = useState(false);
  const [step2Error, setStep2Error] = useState<string | null>(null);

  /* Step 3 form state — one input. */
  const [folderUrl, setFolderUrl] = useState("");
  const [savingStep3, setSavingStep3] = useState(false);
  const [step3Saved, setStep3Saved] = useState(false);
  const [step3Error, setStep3Error] = useState<string | null>(null);

  /* Initial load — gate on auth, then GET /config. */
  const reloadConfig = useCallback(async () => {
    try {
      const res = await fetchWithRefresh(
        "/api/automations/porsche-classes/config",
      );
      if (!res.ok) {
        setLoadError(
          `We couldn't load your settings (HTTP ${res.status}). Refresh the page in a moment.`,
        );
        return;
      }
      const json = (await res.json()) as ConfigResponse;
      setConfig(json);

      /* Pre-fill Step 2 from whatever senders look like email addresses
         in the existing config. Heuristic: first @-bearing string is
         survey, second is cognito. The operator can edit either before
         saving. */
      const emails = json.inbox_filters.sender_match.filter((s) =>
        /@/.test(s),
      );
      if (emails[0]) setSurveySender(emails[0]);
      if (emails[1]) setCognitoSender(emails[1]);

      setLoadError(null);
    } catch (err) {
      setLoadError(
        `Something went wrong loading your settings: ${(err as Error).message}`,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!getInstinctToken()) {
      rerouteToLogin();
      return;
    }
    void reloadConfig();
  }, [reloadConfig]);

  /* ---------------------------------------------------------------- */
  /* Step 1 — Connect Outlook                                         */
  /* ---------------------------------------------------------------- */
  const [connectingMs, setConnectingMs] = useState(false);
  const [step1Error, setStep1Error] = useState<string | null>(null);

  async function handleConnectOutlook() {
    setConnectingMs(true);
    setStep1Error(null);
    const result = await startMicrosoftConnect({
      returnTo: "/automations/porsche-classes/setup",
    });
    if (!result.ok) {
      setStep1Error(result.error);
      setConnectingMs(false);
    }
    /* On success, startMicrosoftConnect navigates away. */
  }

  /* ---------------------------------------------------------------- */
  /* Step 2 — sender allow-list                                       */
  /* ---------------------------------------------------------------- */
  async function handleSaveSenders(e: React.FormEvent) {
    e.preventDefault();
    setSavingStep2(true);
    setStep2Error(null);
    setStep2Saved(false);

    /* Build the new sender list: keep any non-email tokens (e.g.
       "@thewolfpack.agency") + the two operator-supplied addresses,
       trim + dedupe. Subject filters are left as-is — Step 2 only
       updates senders. */
    const existingNonEmails = (config?.inbox_filters.sender_match ?? []).filter(
      (s) => !/@/.test(s) || s.startsWith("@"),
    );
    const newSenders = [
      ...existingNonEmails,
      surveySender.trim(),
      cognitoSender.trim(),
    ].filter((s) => s.length > 0);

    try {
      const res = await fetchWithRefresh(
        "/api/automations/porsche-classes/config",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            inbox_filters: {
              sender_match: newSenders,
              subject_match: config?.inbox_filters.subject_match ?? [],
            },
          }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStep2Error(
          body.error ??
            "Something went wrong saving the email addresses. Try again.",
        );
        return;
      }
      const fresh = (await res.json()) as ConfigResponse;
      setConfig(fresh);
      setStep2Saved(true);
    } catch (err) {
      setStep2Error(
        `Something went wrong saving the email addresses: ${(err as Error).message}`,
      );
    } finally {
      setSavingStep2(false);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Step 3 — SharePoint folder URL                                   */
  /* ---------------------------------------------------------------- */
  async function handleSaveFolder(e: React.FormEvent) {
    e.preventDefault();
    setSavingStep3(true);
    setStep3Error(null);
    setStep3Saved(false);

    if (!folderUrl.trim()) {
      setStep3Error("Paste a SharePoint folder URL first.");
      setSavingStep3(false);
      return;
    }

    try {
      const saveRes = await fetchWithRefresh(
        "/api/automations/porsche-classes/config",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sharepoint: { url: folderUrl.trim() },
          }),
        },
      );
      if (!saveRes.ok) {
        const body = (await saveRes.json().catch(() => ({}))) as {
          error?: string;
        };
        setStep3Error(
          body.error ?? "We couldn't save that folder. Check the link and try again.",
        );
        return;
      }
      const fresh = (await saveRes.json()) as ConfigResponse;
      setConfig(fresh);

      /* Run the Graph health check now that the row is saved. */
      const testRes = await fetchWithRefresh(
        "/api/automations/porsche-classes/config/sharepoint-test",
        { method: "POST" },
      );
      const testBody = (await testRes.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!testBody.ok) {
        setStep3Error(
          testBody.error ??
            "We saved the folder but couldn't open it as a test. Try saving again.",
        );
        return;
      }
      setStep3Saved(true);
      setFolderUrl("");
    } catch (err) {
      setStep3Error(
        `Something went wrong saving the folder: ${(err as Error).message}`,
      );
    } finally {
      setSavingStep3(false);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Render                                                           */
  /* ---------------------------------------------------------------- */
  if (loading) {
    return (
      <main data-testid="setup-loading" style={{ padding: "2rem" }}>
        Loading your settings…
      </main>
    );
  }

  if (loadError || !config) {
    return (
      <main data-testid="setup-load-error" style={{ padding: "2rem" }}>
        <h1>Set up Porsche-classes</h1>
        <p role="alert">{loadError ?? "Something went wrong."}</p>
      </main>
    );
  }

  const step1State: StepState = config.status.graph_connected
    ? "ok"
    : step1Error
      ? "error"
      : "warn";
  const step2State: StepState = config.status.inbox_filter_set
    ? "ok"
    : step2Error
      ? "error"
      : "warn";
  const step3State: StepState = config.status.sharepoint_set
    ? step3Error
      ? "error"
      : "ok"
    : step3Error
      ? "error"
      : "warn";

  return (
    <main
      data-testid="setup-page"
      style={{
        padding: "2rem",
        maxWidth: 760,
        margin: "0 auto",
        color: "var(--wp-text)",
      }}
    >
      <Link
        href="/automations/porsche-classes"
        data-testid="setup-back"
        style={{
          fontSize: "0.8rem",
          color: "var(--wp-text-dim)",
          textDecoration: "none",
        }}
      >
        ← Back to Porsche classes
      </Link>

      <header style={{ marginTop: "0.4rem", marginBottom: "1.6rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.7rem" }}>
          Set up Porsche classes
        </h1>
        <p style={{ marginTop: "0.5rem", color: "var(--wp-text-dim)" }}>
          Three small things and we&apos;ll start ingesting class reports for
          you. You can come back to this page any time to change them.
        </p>
      </header>

      {/* Step 1 — Connect Outlook */}
      <StepCard
        step={1}
        title="Connect Outlook"
        state={step1State}
        description="We read class reports from your Outlook inbox. We never send mail on your behalf."
      >
        {config.status.graph_connected ? (
          <p data-testid="step-1-ok-message" style={{ margin: 0, fontSize: "0.92rem" }}>
            Outlook is connected. You&apos;re good to go.
          </p>
        ) : (
          <>
            <button
              type="button"
              onClick={handleConnectOutlook}
              disabled={connectingMs}
              data-testid="connect-outlook"
              style={{
                background: "var(--wp-gold)",
                color: "var(--wp-dark)",
                border: "none",
                padding: "0.55rem 1rem",
                borderRadius: 6,
                fontWeight: 600,
                cursor: connectingMs ? "not-allowed" : "pointer",
              }}
            >
              {connectingMs ? "Opening Microsoft…" : "Connect Outlook"}
            </button>
            {step1Error && (
              <p
                role="alert"
                data-testid="step-1-error"
                style={{ marginTop: "0.6rem", fontSize: "0.85rem", color: "rgb(232,123,123)" }}
              >
                {step1Error}
              </p>
            )}
          </>
        )}
      </StepCard>

      {/* Step 2 — Where the reports come from */}
      <StepCard
        step={2}
        title="Tell us where the reports come from"
        state={step2State}
        description="Add the email addresses that send the survey and Cognito reports. Anything from another sender will be ignored."
      >
        <form onSubmit={handleSaveSenders}>
          <label
            style={{
              display: "block",
              marginBottom: "0.7rem",
              fontSize: "0.9rem",
            }}
          >
            <span
              style={{ display: "block", marginBottom: "0.2rem", color: "var(--wp-text)" }}
            >
              Email address that sends survey reports
            </span>
            <input
              type="email"
              value={surveySender}
              onChange={(e) => setSurveySender(e.target.value)}
              placeholder="reports@example.com"
              data-testid="survey-sender-input"
              style={{
                width: "100%",
                padding: "0.5rem 0.7rem",
                background: "var(--wp-dark)",
                color: "var(--wp-text)",
                border: "1px solid var(--wp-border)",
                borderRadius: 6,
                fontSize: "0.9rem",
              }}
            />
          </label>
          <label
            style={{
              display: "block",
              marginBottom: "0.9rem",
              fontSize: "0.9rem",
            }}
          >
            <span
              style={{ display: "block", marginBottom: "0.2rem", color: "var(--wp-text)" }}
            >
              Email address that sends Cognito coordinator/instructor reports
            </span>
            <input
              type="email"
              value={cognitoSender}
              onChange={(e) => setCognitoSender(e.target.value)}
              placeholder="notifications@cognitoforms.com"
              data-testid="cognito-sender-input"
              style={{
                width: "100%",
                padding: "0.5rem 0.7rem",
                background: "var(--wp-dark)",
                color: "var(--wp-text)",
                border: "1px solid var(--wp-border)",
                borderRadius: 6,
                fontSize: "0.9rem",
              }}
            />
          </label>
          <button
            type="submit"
            disabled={savingStep2}
            data-testid="step-2-save"
            style={{
              background: "var(--wp-gold)",
              color: "var(--wp-dark)",
              border: "none",
              padding: "0.55rem 1rem",
              borderRadius: 6,
              fontWeight: 600,
              cursor: savingStep2 ? "not-allowed" : "pointer",
            }}
          >
            {savingStep2 ? "Saving…" : "Save email senders"}
          </button>
          {step2Saved && !step2Error && (
            <p
              data-testid="step-2-success"
              style={{ marginTop: "0.6rem", fontSize: "0.88rem", color: "rgb(120,210,150)" }}
            >
              ✓ We&apos;ll auto-ingest these emails.
            </p>
          )}
          {step2Error && (
            <p
              role="alert"
              data-testid="step-2-error"
              style={{ marginTop: "0.6rem", fontSize: "0.85rem", color: "rgb(232,123,123)" }}
            >
              {step2Error}
            </p>
          )}
        </form>
      </StepCard>

      {/* Step 3 — SharePoint folder */}
      <StepCard
        step={3}
        title="Where should we save class summaries?"
        state={step3State}
        description="Open the SharePoint folder where you keep class summaries today, copy the link from your browser, and paste it below."
      >
        {config.sharepoint && !step3Error && (
          <p
            data-testid="step-3-current-folder"
            style={{
              marginBottom: "0.7rem",
              fontSize: "0.85rem",
              color: "var(--wp-text-dim)",
            }}
          >
            Currently saving to: <code>{config.sharepoint.path}</code>
          </p>
        )}
        <form onSubmit={handleSaveFolder}>
          <label
            style={{
              display: "block",
              marginBottom: "0.9rem",
              fontSize: "0.9rem",
            }}
          >
            <span
              style={{ display: "block", marginBottom: "0.2rem", color: "var(--wp-text)" }}
            >
              Paste a SharePoint folder URL
            </span>
            <input
              type="url"
              value={folderUrl}
              onChange={(e) => setFolderUrl(e.target.value)}
              placeholder="https://yourcompany.sharepoint.com/sites/.../Shared%20Documents/..."
              data-testid="folder-url-input"
              style={{
                width: "100%",
                padding: "0.5rem 0.7rem",
                background: "var(--wp-dark)",
                color: "var(--wp-text)",
                border: "1px solid var(--wp-border)",
                borderRadius: 6,
                fontSize: "0.9rem",
              }}
            />
          </label>
          <button
            type="submit"
            disabled={savingStep3}
            data-testid="step-3-save"
            style={{
              background: "var(--wp-gold)",
              color: "var(--wp-dark)",
              border: "none",
              padding: "0.55rem 1rem",
              borderRadius: 6,
              fontWeight: 600,
              cursor: savingStep3 ? "not-allowed" : "pointer",
            }}
          >
            {savingStep3 ? "Saving and verifying…" : "Save and verify"}
          </button>
          {step3Saved && !step3Error && (
            <p
              data-testid="step-3-success"
              style={{ marginTop: "0.6rem", fontSize: "0.88rem", color: "rgb(120,210,150)" }}
            >
              ✓ Folder saved. We&apos;ll drop class summaries here from now on.
            </p>
          )}
          {step3Error && (
            <p
              role="alert"
              data-testid="step-3-error"
              style={{ marginTop: "0.6rem", fontSize: "0.85rem", color: "rgb(232,123,123)" }}
            >
              {step3Error}
            </p>
          )}
        </form>
      </StepCard>

      {/* Anthropic key — informational only; non-technical operators can't
          set it themselves. We surface a status line so the page tells the
          full truth instead of silently ignoring the env-var dependency. */}
      {!config.status.anthropic_set && (
        <section
          data-testid="anthropic-warning"
          style={{
            background: "rgba(229,180,69,0.10)",
            border: "1px solid rgba(229,180,69,0.45)",
            borderLeftWidth: 4,
            borderRadius: 6,
            padding: "0.7rem 0.9rem",
            marginTop: "1rem",
            color: "var(--wp-text)",
            fontSize: "0.9rem",
          }}
        >
          One more thing: AI summaries need an Anthropic API key. Ask the
          CTO to add it before your next class — once it&apos;s set, this
          banner will go away.
        </section>
      )}
    </main>
  );
}
