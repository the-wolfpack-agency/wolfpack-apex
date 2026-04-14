"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { getInstinctToken, getInstinctUser, jsonHeaders, authHeaders } from "@/lib/client-auth";

interface UserInfo {
  id: string;
  name: string;
  email: string;
  role: string;
}

interface InviteRow {
  email: string;
  role: string;
}

const STEPS = ["Workspace Info", "Invite Team", "Connect Integrations", "You're Ready"];

export default function SetupPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [user, setUser] = useState<UserInfo | null>(null);

  // Step 1 state
  const [workspaceName, setWorkspaceName] = useState("");
  const [userName, setUserName] = useState("");
  const [userEmail, setUserEmail] = useState("");

  // Step 2 state
  const [invites, setInvites] = useState<InviteRow[]>([{ email: "", role: "dev" }]);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSent, setInviteSent] = useState(false);

  // Step 3 state — tracked for summary
  const [integrationsSkipped, setIntegrationsSkipped] = useState(false);

  useEffect(() => {
    const token = getInstinctToken();
    const parsed = getInstinctUser<UserInfo>();
    if (!token || !parsed) {
      router.push("/login");
      return;
    }
    setUser(parsed);
    setUserName(parsed.name || "");
    setUserEmail(parsed.email || "");
    setWorkspaceName("My Workspace");

    // Track setup started
    fetch("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ event: "system.setup_started", metadata: { step: 0 } }),
    }).catch(() => {});
  }, [router]);

  function goNext() {
    const nextStep = step + 1;
    setStep(nextStep);
    // Track step completion
    fetch("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        event: "system.setup_step_completed",
        metadata: { step: step, step_name: STEPS[step] },
      }),
    }).catch(() => {});
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
      goNext();
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
        setInviteError(data.error || "Failed to send invites");
        return;
      }
      setInviteSent(true);
      goNext();
    } catch {
      setInviteError("Network error. Please try again.");
    }
  }

  async function completeSetup() {
    // Track completion
    fetch("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ event: "system.setup_completed", metadata: {} }),
    }).catch(() => {});
    router.push("/");
  }

  if (!user) {
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
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
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
                Email
              </label>
              <input
                type="email"
                value={userEmail}
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
            <div className="flex justify-end">
              <button
                onClick={goNext}
                disabled={!workspaceName.trim()}
                className="px-5 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                style={{ background: "var(--wp-gold)", color: "var(--wp-dark)" }}
              >
                Continue
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
                  onClick={goNext}
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
              {[
                { name: "Microsoft 365", desc: "Calendar, emails, and meeting prep" },
                { name: "QuickBooks", desc: "Financial reports and dashboards" },
                { name: "Plaud", desc: "Meeting recordings and transcripts" },
              ].map((integration) => (
                <div
                  key={integration.name}
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
                    onClick={() => router.push("/settings")}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border"
                    style={{ borderColor: "var(--wp-gold)", color: "var(--wp-gold)" }}
                  >
                    Connect
                  </button>
                </div>
              ))}
            </div>
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
                  goNext();
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
