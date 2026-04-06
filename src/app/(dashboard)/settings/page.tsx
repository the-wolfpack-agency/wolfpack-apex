"use client";

import { useState, useEffect, useCallback } from "react";

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

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [microsoftStatus, setMicrosoftStatus] = useState<MicrosoftStatus>({ connected: false });
  const [quickbooksStatus, setQuickbooksStatus] = useState<QuickBooksStatus>({ connected: false });
  const [loadingMicrosoft, setLoadingMicrosoft] = useState(true);
  const [loadingQuickbooks, setLoadingQuickbooks] = useState(true);
  const [briefingEnabled, setBriefingEnabled] = useState(true);
  const [emailNotifications, setEmailNotifications] = useState(true);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);

  function getToken() {
    return localStorage.getItem("apex_token") || "";
  }

  function decodeUser(): UserInfo | null {
    const stored = localStorage.getItem("apex_user");
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        return { name: parsed.name || "", email: parsed.email || "", role: parsed.role || "" };
      } catch {
        // fall through to JWT decode
      }
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
      const res = await fetch("/api/microsoft?action=status", {
        headers: { Authorization: `Bearer ${getToken()}` },
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

  const fetchQuickbooksStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/quickbooks?action=status", {
        headers: { Authorization: `Bearer ${getToken()}` },
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

    // Load preferences from localStorage
    const briefing = localStorage.getItem("apex_briefing_enabled");
    if (briefing !== null) setBriefingEnabled(briefing === "true");
    const notifs = localStorage.getItem("apex_email_notifications");
    if (notifs !== null) setEmailNotifications(notifs === "true");

    // Track page view
    fetch("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ event: "system.page_viewed", metadata: { page: "settings" } }),
    }).catch(() => {});

    // Fetch integration statuses
    fetchMicrosoftStatus();
    fetchQuickbooksStatus();
  }, [fetchMicrosoftStatus, fetchQuickbooksStatus]);

  async function connectMicrosoft() {
    try {
      const res = await fetch("/api/microsoft?action=auth-url", {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const data = await res.json();
      if (data.authUrl) {
        window.location.href = data.authUrl;
      }
    } catch {
      // Non-fatal
    }
  }

  async function disconnectMicrosoft() {
    setDisconnecting("microsoft");
    try {
      const res = await fetch("/api/microsoft?action=disconnect", {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (res.ok) {
        setMicrosoftStatus({ connected: false });
      }
    } catch {
      // Non-fatal
    }
    setDisconnecting(null);
  }

  async function connectQuickbooks() {
    try {
      const res = await fetch("/api/quickbooks?action=auth-url", {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      const data = await res.json();
      if (data.authUrl) {
        window.location.href = data.authUrl;
      }
    } catch {
      // Non-fatal
    }
  }

  async function disconnectQuickbooks() {
    setDisconnecting("quickbooks");
    try {
      const res = await fetch("/api/quickbooks?action=disconnect", {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (res.ok) {
        setQuickbooksStatus({ connected: false });
      }
    } catch {
      // Non-fatal
    }
    setDisconnecting(null);
  }

  function toggleBriefing() {
    const next = !briefingEnabled;
    setBriefingEnabled(next);
    localStorage.setItem("apex_briefing_enabled", String(next));
  }

  function toggleEmailNotifications() {
    const next = !emailNotifications;
    setEmailNotifications(next);
    localStorage.setItem("apex_email_notifications", String(next));
  }

  function fmtDate(d: string): string {
    try {
      return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } catch {
      return d;
    }
  }

  const isExecutive = user?.role === "ceo" || user?.role === "cto";

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
          </div>
        )}
      </SectionCard>

      {/* QuickBooks Integration (CEO/CTO only) */}
      {isExecutive && (
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
