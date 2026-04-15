"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { getInstinctToken, getInstinctUser, jsonHeaders } from "@/lib/client-auth";
import {
  startMicrosoftConnect,
  startQuickbooksConnect,
  connectPlaud as connectPlaudHelper,
} from "@/lib/integrations/connect";
import { loadDraft, saveDraft, clearDraft } from "@/lib/setup-draft";

interface UserInfo {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface WorkspaceStatus {
  complete: boolean;
  steps: {
    profile: boolean;
    team: boolean;
    integrations: boolean;
  };
  nextStep: "profile" | "team" | "integrations" | "complete";
}

interface InviteRow {
  email: string;
  role: string;
}

const STEPS = ["Workspace Info", "Invite Team", "Connect Integrations", "You're Ready"];
const STEP_KEYS = ["profile", "team", "integrations", "complete"] as const;

function nextStepToIndex(nextStep: WorkspaceStatus["nextStep"]): number {
  switch (nextStep) {
    case "profile": return 0;
    case "team": return 1;
    case "integrations": return 2;
    case "complete": return 3;
    default: return 0;
  }
}

export default function SetupPage() {
  const router = useRouter();
  const routerRef = useRef(router);
  useEffect(() => { routerRef.current = router; });
  const [user, setUser] = useState<UserInfo | null>(null);
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [step, setStep] = useState(0);
  const [statusLoading, setStatusLoading] = useState(true);

  // Step 1 state
  const [workspaceName, setWorkspaceName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Step 2 state
  const [invites, setInvites] = useState<InviteRow[]>([{ email: "", role: "dev" }]);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSent, setInviteSent] = useState(false);

  // Step 3 state — tracked for summary
  const [integrationsSkipped, setIntegrationsSkipped] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const stepViewedAtRef = useRef<number>(Date.now());
  const prevIntegrationsRef = useRef<boolean | null>(null);

  const emitSetupEvent = useCallback(
    (event: string, extra: Record<string, string | number | boolean> = {}) => {
      const role = user?.role ?? "unknown";
      fetch("/api/analytics", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          event,
          metadata: {
            step: STEP_KEYS[step] ?? "profile",
            step_name: STEPS[step] ?? STEPS[0],
            duration_ms: Date.now() - stepViewedAtRef.current,
            attempt_number: 1,
            user_role: role,
            ...extra,
          },
        }),
      }).catch(() => {});
    },
    [step, user],
  );

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/workspace/status", {
        headers: jsonHeaders(),
      });
      if (res.status === 401) {
        routerRef.current.push("/login");
        return;
      }
      if (res.ok) {
        const data: WorkspaceStatus = await res.json();
        const wasIntegrationsComplete = prevIntegrationsRef.current;
        if (wasIntegrationsComplete === false && data.steps.integrations === true) {
          fetch("/api/analytics", {
            method: "POST",
            headers: jsonHeaders(),
            body: JSON.stringify({
              event: "system.setup_integration_connect_succeeded",
              metadata: {
                step: "integrations",
                step_name: STEPS[2],
                duration_ms: Date.now() - stepViewedAtRef.current,
                attempt_number: 1,
                user_role: "unknown",
              },
            }),
          }).catch(() => {});
        }
        prevIntegrationsRef.current = data.steps.integrations;
        setStatus(data);
        setStep(nextStepToIndex(data.nextStep));
      }
    } catch {
      // Non-fatal — keep current step
    }
    setStatusLoading(false);
  }, []);

  useEffect(() => {
    const token = getInstinctToken();
    const parsed = getInstinctUser<UserInfo>();
    if (!token || !parsed) {
      routerRef.current.push("/login");
      return;
    }
    setUser(parsed);

    // Load draft state
    const draft = loadDraft();
    if (draft.workspaceName) {
      setWorkspaceName(draft.workspaceName);
    }
    if (draft.invites && draft.invites.length > 0) {
      setInvites(draft.invites);
    }

    fetchStatus();

    // Track setup started
    fetch("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ event: "system.setup_started", metadata: { step: 0 } }),
    }).catch(() => {});
  }, [fetchStatus]);

  // Refetch on window focus so OAuth round-trips re-sync status
  useEffect(() => {
    function onFocus() {
      fetchStatus();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [fetchStatus]);

  // Persist workspace name draft as user types
  useEffect(() => {
    if (workspaceName.trim()) {
      const draft = loadDraft();
      saveDraft({ ...draft, workspaceName });
    }
  }, [workspaceName]);

  // Persist invite draft as user types
  useEffect(() => {
    const draft = loadDraft();
    saveDraft({ ...draft, invites });
  }, [invites]);

  function emitStepCompleted(stepIndex: number) {
    const role = user?.role ?? "unknown";
    fetch("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: "system.setup_step_completed",
        metadata: {
          step: STEP_KEYS[stepIndex] ?? "profile",
          step_name: STEPS[stepIndex] ?? STEPS[0],
          duration_ms: Date.now() - stepViewedAtRef.current,
          attempt_number: 1,
          user_role: role,
        },
      }),
    }).catch(() => {});
  }

  // Emit step_viewed whenever the step changes (and reset the step timer)
  useEffect(() => {
    if (statusLoading) return;
    stepViewedAtRef.current = Date.now();
    emitSetupEvent("system.setup_step_viewed");
  }, [step, statusLoading, emitSetupEvent]);

  // Fire step_abandoned on tab hide / unload
  useEffect(() => {
    function onHide() {
      if (document.visibilityState === "hidden" && step < 3) {
        emitSetupEvent("system.setup_step_abandoned");
      }
    }
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [step, emitSetupEvent]);

  async function saveWorkspace() {
    setSaveError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/workspace", {
        method: "PUT",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: workspaceName.trim() }),
      });
      if (res.ok) {
        clearDraft();
        emitStepCompleted(0);
        await fetchStatus();
      } else if (res.status === 400) {
        const data = await res.json().catch(() => ({}));
        setSaveError((data as { error?: string }).error || "Invalid workspace name.");
      } else if (res.status === 503) {
        setSaveError("Service temporarily unavailable. Please try again.");
      } else {
        setSaveError("Failed to save workspace. Please try again.");
      }
    } catch {
      setSaveError("Network error. Please try again.");
    }
    setSaving(false);
  }

  function goBack() {
    if (step > 0) setStep(step - 1);
  }

  function addInviteRow() {
    setInvites([...invites, { email: "", role: "dev" }]);
  }

  function updateInvite(index: number, field: keyof InviteRow, value: string) {
    const updated = [...invites];
    updated[index] = { ...updated[index], [field]: value };
    setInvites(updated);
  }

  function removeInvite(index: number) {
    if (invites.length <= 1) return;
    setInvites(invites.filter((_, i) => i !== index));
  }

  async function submitInvites() {
    setInviteError(null);
    const validInvites = invites.filter((i) => i.email.includes("@"));
    if (validInvites.length === 0) {
      emitStepCompleted(1);
      await fetchStatus();
      return;
    }
    try {
      const res = await fetch("/api/team/invite", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ invites: validInvites }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setInviteError((data as { error?: string }).error || "Failed to send invites");
        return;
      }
      setInviteSent(true);
      emitStepCompleted(1);
      await fetchStatus();
    } catch {
      setInviteError("Network error. Please try again.");
    }
  }

  async function skipInvites() {
    emitStepCompleted(1);
    await fetchStatus();
    // If server hasn't advanced (team may still show incomplete), nudge client view
    setStep((prev) => (prev < 2 ? 2 : prev));
  }

  async function handleConnect(integration: "microsoft" | "quickbooks" | "plaud") {
    setConnectError(null);
    emitSetupEvent("system.setup_integration_connect_started", { integration });
    let result: { ok: true } | { ok: false; error: string };
    if (integration === "microsoft") {
      result = await startMicrosoftConnect({ returnTo: "/setup" });
    } else if (integration === "quickbooks") {
      result = await startQuickbooksConnect({ returnTo: "/setup" });
    } else {
      result = await connectPlaudHelper(true);
      if (result.ok) {
        emitSetupEvent("system.setup_integration_connect_succeeded", { integration });
        await fetchStatus();
      }
    }
    if (!result.ok) {
      emitSetupEvent("system.setup_integration_connect_failed", {
        integration,
        error: result.error,
      });
      setConnectError(result.error);
    }
  }

  async function completeSetup() {
    emitSetupEvent("system.setup_completed");
    routerRef.current.push("/");
  }

  if (statusLoading || !user) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading...</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto py-8 space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold" style={{ color: "var(--wp-gold)" }}>
          Set up your workspace
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim)" }}>
          Step {step + 1} of {STEPS.length}: {STEPS[step]}
        </p>
      </div>

      {/* Progress bar */}
      <div className="flex gap-2">
        {STEPS.map((_, i) => (
          <div
            key={i}
            className="flex-1 h-1.5 rounded-full transition-colors"
            style={{
              background: i <= step ? "var(--wp-gold)" : "var(--wp-border, var(--wp-dark-border))",
            }}
          />
        ))}
      </div>

      {/* Step content */}
      <div
        className="rounded-lg border p-6"
        style={{ background: "var(--wp-card, var(--wp-dark-surface))", borderColor: "var(--wp-border, var(--wp-dark-border))" }}
      >
        {/* Step 1: Workspace Info */}
        {step === 0 && (
          <div className="space-y-5">
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: "var(--wp-text)" }}>
                Workspace Name
              </label>
              <input
                type="text"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder="Your company or team name"
                className="w-full px-3 py-2 rounded-lg border text-sm outline-none transition-colors focus:border-[var(--wp-gold)]"
                style={{
                  background: "var(--wp-dark-surface2, var(--wp-dark))",
                  borderColor: "var(--wp-border, var(--wp-dark-border))",
                  color: "var(--wp-text)",
                }}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: "var(--wp-text)" }}>
                Your Name
              </label>
              <input
                type="text"
                value={user.name}
                disabled
                className="w-full px-3 py-2 rounded-lg border text-sm outline-none opacity-60"
                style={{
                  background: "var(--wp-dark-surface2, var(--wp-dark))",
                  borderColor: "var(--wp-border, var(--wp-dark-border))",
                  color: "var(--wp-text-dim)",
                }}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5" style={{ color: "var(--wp-text)" }}>
                Email
              </label>
              <input
                type="email"
                value={user.email}
                disabled
                className="w-full px-3 py-2 rounded-lg border text-sm outline-none opacity-60"
                style={{
                  background: "var(--wp-dark-surface2, var(--wp-dark))",
                  borderColor: "var(--wp-border, var(--wp-dark-border))",
                  color: "var(--wp-text-dim)",
                }}
              />
              <p className="text-xs mt-1" style={{ color: "var(--wp-text-dim)" }}>
                Email comes from your login and cannot be changed here.
              </p>
            </div>
            {saveError && (
              <p className="text-sm" style={{ color: "var(--wp-error, #ef4444)" }}>{saveError}</p>
            )}
            <div className="flex justify-end">
              <button
                onClick={saveWorkspace}
                disabled={!workspaceName.trim() || saving}
                className="px-5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
              >
                {saving ? "Saving..." : "Continue"}
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Invite Team */}
        {step === 1 && (
          <div className="space-y-5">
            <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
              Add team members to your workspace. They will receive an invite link.
            </p>
            {invites.map((inv, i) => (
              <div key={i} className="flex gap-3 items-start">
                <input
                  type="email"
                  value={inv.email}
                  onChange={(e) => updateInvite(i, "email", e.target.value)}
                  placeholder="teammate@company.com"
                  className="flex-1 px-3 py-2 rounded-lg border text-sm outline-none transition-colors focus:border-[var(--wp-gold)]"
                  style={{
                    background: "var(--wp-dark-surface2, var(--wp-dark))",
                    borderColor: "var(--wp-border, var(--wp-dark-border))",
                    color: "var(--wp-text)",
                  }}
                />
                <select
                  value={inv.role}
                  onChange={(e) => updateInvite(i, "role", e.target.value)}
                  className="px-3 py-2 rounded-lg border text-sm outline-none"
                  style={{
                    background: "var(--wp-dark-surface2, var(--wp-dark))",
                    borderColor: "var(--wp-border, var(--wp-dark-border))",
                    color: "var(--wp-text)",
                  }}
                >
                  <option value="dev">Developer</option>
                  <option value="sales">Sales</option>
                  <option value="ops">Operations</option>
                  <option value="hr">HR</option>
                </select>
                {invites.length > 1 && (
                  <button
                    onClick={() => removeInvite(i)}
                    className="p-2 rounded-lg text-sm transition-colors"
                    style={{ color: "var(--wp-text-muted)" }}
                    title="Remove"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
            <button
              onClick={addInviteRow}
              className="text-sm font-medium transition-colors"
              style={{ color: "var(--wp-gold)" }}
            >
              + Add another
            </button>
            {inviteError && (
              <p className="text-sm" style={{ color: "var(--wp-error, #ef4444)" }}>{inviteError}</p>
            )}
            <div className="flex justify-between pt-2">
              <button
                onClick={goBack}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-colors border"
                style={{ borderColor: "var(--wp-border, var(--wp-dark-border))", color: "var(--wp-text-dim)" }}
              >
                Back
              </button>
              <div className="flex gap-3">
                <button
                  onClick={skipInvites}
                  className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={{ color: "var(--wp-text-dim)" }}
                >
                  Skip for now
                </button>
                <button
                  onClick={submitInvites}
                  className="px-5 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
                >
                  Send Invites
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Connect Integrations */}
        {step === 2 && (
          <div className="space-y-5">
            <p className="text-sm" style={{ color: "var(--wp-text-dim)" }}>
              Connect your tools to get the most out of Instinct. You can always do this later in Settings.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {(
                [
                  { key: "microsoft", name: "Microsoft 365", desc: "Calendar, emails, and meeting prep" },
                  { key: "quickbooks", name: "QuickBooks", desc: "Financial reports and dashboards" },
                  { key: "plaud", name: "Plaud", desc: "Meeting recordings and transcripts" },
                ] as const
              ).map((integration) => (
                <div
                  key={integration.key}
                  className="rounded-lg border p-4 flex flex-col items-center text-center gap-3"
                  style={{
                    background: "var(--wp-dark-surface2, var(--wp-dark))",
                    borderColor: "var(--wp-border, var(--wp-dark-border))",
                  }}
                >
                  <p className="text-sm font-medium" style={{ color: "var(--wp-text)" }}>
                    {integration.name}
                  </p>
                  <p className="text-xs" style={{ color: "var(--wp-text-dim)" }}>
                    {integration.desc}
                  </p>
                  <button
                    onClick={() => handleConnect(integration.key)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border"
                    style={{ borderColor: "var(--wp-gold)", color: "var(--wp-gold)" }}
                  >
                    Connect
                  </button>
                </div>
              ))}
            </div>
            {connectError && (
              <p className="text-sm" style={{ color: "var(--wp-warning, #f59e0b)" }}>{connectError}</p>
            )}
            <div className="flex justify-between pt-2">
              <button
                onClick={goBack}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-colors border"
                style={{ borderColor: "var(--wp-border, var(--wp-dark-border))", color: "var(--wp-text-dim)" }}
              >
                Back
              </button>
              <button
                onClick={() => {
                  setIntegrationsSkipped(true);
                  emitStepCompleted(2);
                  setStep(3);
                }}
                className="px-5 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {/* Step 4: You're Ready */}
        {step === 3 && (
          <div className="space-y-5 text-center">
            <div
              className="w-16 h-16 mx-auto rounded-full flex items-center justify-center"
              style={{ background: "var(--wp-gold)20" }}
            >
              <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="var(--wp-gold)" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-xl font-bold" style={{ color: "var(--wp-text)" }}>
              You are all set!
            </h2>
            <div className="text-sm space-y-1" style={{ color: "var(--wp-text-dim)" }}>
              <p>Workspace: <strong style={{ color: "var(--wp-text)" }}>{workspaceName}</strong></p>
              {inviteSent && (
                <p>
                  Team invites sent to{" "}
                  <strong style={{ color: "var(--wp-text)" }}>
                    {invites.filter((i) => i.email.includes("@")).length}
                  </strong>{" "}
                  {invites.filter((i) => i.email.includes("@")).length === 1 ? "person" : "people"}
                </p>
              )}
              {integrationsSkipped && (
                <p>
                  Integrations skipped — you can connect them anytime in{" "}
                  <a href="/settings" style={{ color: "var(--wp-gold)" }}>Settings</a>.
                </p>
              )}
              {status?.steps.integrations && (
                <p>Integrations connected.</p>
              )}
            </div>
            <button
              onClick={completeSetup}
              className="px-6 py-2.5 rounded-lg text-sm font-medium transition-colors"
              style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
            >
              Go to Dashboard
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
