"use client";

import { useState, useEffect, ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  getInstinctToken,
  getInstinctUser,
  clearInstinctSession,
  fetchWithRefresh,
  migrateLegacyApexKeys,
} from "@/lib/client-auth";
import NotificationBell from "@/components/NotificationBell";
import TeamsUnreadBadge from "@/components/TeamsUnreadBadge";
import NewMessageToast from "@/components/NewMessageToast";
import MessagesNavBadge from "@/components/MessagesNavBadge";
import EmailNavBadge from "@/components/EmailNavBadge";
import InstinctChat from "@/components/InstinctChat";
import WelcomeTooltip from "@/components/WelcomeTooltip";
import { useAmbientRefresh } from "@/lib/hooks/useAmbientRefresh";

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

const NAV_ITEMS = [
  { label: "Assistant", href: "/assistant", icon: "M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" },
  { label: "Dashboard", href: "/", icon: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1" },
  { label: "Search", href: "/search", icon: "M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" },
  { label: "Emails", href: "/emails", icon: "M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" },
  { label: "Messages", href: "/messages", icon: "M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" },
  { label: "Calendar", href: "/calendar", icon: "M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" },
  { label: "Knowledge", href: "/knowledge", icon: "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" },
  { label: "Meetings", href: "/meetings/feeds", icon: "M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" },
  { label: "Tasks", href: "/tasks", icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" },
  { label: "Goals", href: "/goals", icon: "M15 12a3 3 0 11-6 0 3 3 0 016 0z M12 1v4 M12 19v4 M4.22 4.22l2.83 2.83 M16.95 16.95l2.83 2.83 M1 12h4 M19 12h4 M4.22 19.78l2.83-2.83 M16.95 7.05l2.83-2.83" },
  { label: "Journal", href: "/journal", icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" },
  { label: "Features", href: "/features", icon: "M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" },
  { label: "Discussions", href: "/discussions", icon: "M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z" },
  { label: "Bulletin", href: "/bulletin", icon: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-1 9l-3 3m0 0l-3-3m3 3V10" },
  { label: "Docs", href: "/docs", icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" },
  { label: "Reports", href: "/reports", icon: "M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" },
  { label: "Clients", href: "/clients", icon: "M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" },
  { label: "Sites", href: "/sites", icon: "M3.75 3v11.25A2.25 2.25 0 006 16.5h12A2.25 2.25 0 0020.25 14.25V3M3.75 21h16.5M16.5 3.75h.008v.008H16.5V3.75zM12 3.75h.008v.008H12V3.75zM7.5 3.75h.008v.008H7.5V3.75z" },
  { label: "HR", href: "/hr", roles: ["ceo", "cto", "hr"], icon: "M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" },

  { label: "Financials", href: "/financials", roles: ["ceo", "cto"], icon: "M12 6v12m-3-2.818l.879.659c1.171.879 3.07.879 4.242 0 1.172-.879 1.172-2.303 0-3.182C13.536 12.219 12.768 12 12 12c-.725 0-1.45-.22-2.003-.659-1.106-.879-1.106-2.303 0-3.182s2.9-.879 4.006 0l.415.33M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
  { label: "Analytics", href: "/analytics", icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" },
  { label: "Tools", href: "/tools", icon: "M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l5.653-4.655m2.588 2.588l6.294-6.294a2.25 2.25 0 00-3.182-3.182l-6.294 6.294m2.588 2.588l-2.588-2.588" },
  { label: "QR Codes", href: "/qr", icon: "M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.375v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0113.5 9.375v-4.5z M6.75 6.75h.75v.75h-.75v-.75zM6.75 16.5h.75v.75h-.75v-.75zM16.5 6.75h.75v.75h-.75v-.75zM13.5 13.5h.75v.75h-.75v-.75zM13.5 19.5h.75v.75h-.75v-.75zM19.5 13.5h.75v.75h-.75v-.75zM19.5 19.5h.75v.75h-.75v-.75zM16.5 16.5h.75v.75h-.75v-.75z" },
  { label: "Automations", href: "/automations", icon: "M13 10V3L4 14h7v7l9-11h-7z" },
  { label: "Support", href: "/support", icon: "M18.364 5.636l-3.536 3.536m0 5.656l3.536 3.536M9.172 9.172L5.636 5.636m3.536 9.192l-3.536 3.536M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-5 0a4 4 0 11-8 0 4 4 0 018 0z" },
  { label: "Settings", href: "/settings", icon: "M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z M15 12a3 3 0 11-6 0 3 3 0 016 0z" },
];

const ROLE_COLORS: Record<string, string> = {
  ceo: "var(--wp-gold)",
  cto: "var(--wp-gold)",
  dev: "var(--wp-info)",
  sales: "var(--wp-success)",
  ops: "var(--wp-warning)",
};

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Ambient RAG refresh orchestrator (Path C · Stream U6). Silent by
  // design — runs a session-start warm pass of recent cached queries
  // and an idle-driven stale refresh loop. No UI, no prompts. Mounts
  // once here so every dashboard route benefits.
  useAmbientRefresh();

  useEffect(() => {
    // One-shot migration: before reading auth state, promote any legacy
    // `apex_*` localStorage keys to their canonical `instinct_*` names
    // so users logged in before the 2026-04-19 rename keep their session
    // and preferences without re-authenticating. Idempotent and safe to
    // call on every mount — a no-op after the first run.
    migrateLegacyApexKeys();

    const token = getInstinctToken();
    const parsed = getInstinctUser<User>();
    if (!token || !parsed) {
      router.push("/login");
      return;
    }
    setUser(parsed);
  }, [router]);

  // Register the Instinct service worker + listen for the PWA install
  // prompt. Scoped to root so it controls every dashboard page; fires
  // analytics via /api/analytics (fire-and-forget) for pwa.* events.
  // Graceful degradation: any registration error is swallowed — the
  // app keeps working online even if the SW can't install (Safari ITP,
  // private mode, iframes, dev servers without HTTPS).
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .catch((err) => {
        console.warn("[sw] registration failed:", (err as Error).message);
      });

    function trackPwa(event: string, metadata: Record<string, string | number | boolean> = {}) {
      if (!getInstinctToken()) return;
      void fetchWithRefresh("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, metadata }),
        keepalive: true,
      }).catch(() => undefined);
    }

    const onBeforeInstall = (e: Event) => {
      // Let the browser show its native prompt; we just track visibility.
      trackPwa("pwa.install_prompt_shown");
      // Capture the event so other UI can trigger install if desired.
      (window as unknown as { __instinctInstallPrompt?: Event }).__instinctInstallPrompt = e;
    };
    const onInstalled = () => trackPwa("pwa.installed");
    const onAppinstalled = () => trackPwa("pwa.installed");

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onAppinstalled);
    window.addEventListener("instinctinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onAppinstalled);
      window.removeEventListener("instinctinstalled", onInstalled);
    };
  }, []);

  function handleLogout() {
    clearInstinctSession();
    router.push("/login");
  }

  function isActive(href: string) {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  }

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "var(--wp-dark)" }}>
        <div className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading...</div>
      </div>
    );
  }

  return (
    <div
      className="flex overflow-hidden"
      style={{
        background: "var(--wp-dark)",
        /* Use dynamic viewport height so iOS Safari's collapsing toolbar
           doesn't clip the bottom of the page. h-screen / 100vh assumes the
           toolbar is hidden, so when it reappears the bottom of <main>
           hides under it (text/buttons clipped near the page footer). */
        height: "100dvh",
      }}
    >
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-40 w-64 border-r flex flex-col transition-transform lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        style={{
          background: "var(--wp-dark-surface)",
          borderColor: "var(--wp-dark-border)",
        }}
      >
        {/* Logo */}
        <div
          className="flex items-center gap-3 px-5 py-4 border-b"
          style={{ borderColor: "var(--wp-dark-border)" }}
        >
          <img src="/wolfpack-logo.png" alt="Wolfpack" className="h-8 w-auto" />
          <span className="text-xl font-bold" style={{ color: "var(--wp-gold)" }}>
            Instinct
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.filter((item) => !item.roles || item.roles.includes(user.role)).map((item) => {
            const active = isActive(item.href);
            return (
              <a
                key={item.href}
                href={item.href}
                onClick={(e) => {
                  e.preventDefault();
                  router.push(item.href);
                  setSidebarOpen(false);
                }}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
                style={{
                  background: active ? "var(--wp-dark-surface2)" : "transparent",
                  color: active ? "var(--wp-gold)" : "var(--wp-text-dim)",
                }}
              >
                <svg
                  className="w-5 h-5 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={1.5}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
                </svg>
                {item.label}
                {item.href === "/messages" ? <MessagesNavBadge /> : null}
                {item.href === "/emails" ? <EmailNavBadge /> : null}
              </a>
            );
          })}
        </nav>

        {/* User */}
        <div
          className="px-4 py-4 border-t pb-[max(1rem,env(safe-area-inset-bottom))]"
          style={{ borderColor: "var(--wp-dark-border)" }}
        >
          <div className="flex items-center gap-3">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold"
              style={{
                background: "var(--wp-dark-surface2)",
                color: ROLE_COLORS[user.role] || "var(--wp-text-dim)",
              }}
            >
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{user.name}</p>
              <span
                className="inline-block text-xs px-1.5 py-0.5 rounded font-medium"
                style={{
                  background: `${ROLE_COLORS[user.role] || "var(--wp-text-dim)"}20`,
                  color: ROLE_COLORS[user.role] || "var(--wp-text-dim)",
                }}
              >
                {user.role.toUpperCase()}
              </span>
            </div>
            <button
              onClick={handleLogout}
              className="text-xs px-2 py-1 rounded transition-colors"
              style={{ color: "var(--wp-text-muted)" }}
              title="Sign out"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile header */}
        <header
          className="lg:hidden flex items-center gap-3 px-4 py-3 border-b"
          style={{ borderColor: "var(--wp-dark-border)" }}
        >
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-1"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <img src="/wolfpack-logo.png" alt="Wolfpack" className="h-6 w-auto" />
          <span className="text-lg font-bold" style={{ color: "var(--wp-gold)" }}>Instinct</span>
          <div className="ml-auto flex items-center gap-2">
            <TeamsUnreadBadge />
            <NotificationBell />
          </div>
        </header>

        {/* Desktop top bar (bell lives here; sidebar owns nav) */}
        <header
          className="hidden lg:flex items-center justify-end gap-2 px-6 py-2 border-b"
          style={{ borderColor: "var(--wp-dark-border)" }}
        >
          <TeamsUnreadBadge />
          <NotificationBell />
        </header>

        <main
          className="flex-1 overflow-y-auto overflow-x-hidden p-4 md:p-6 lg:p-8"
          style={{
            paddingBottom:
              "max(1rem, calc(env(safe-area-inset-bottom) + 1rem))",
          }}
        >
          {children}
        </main>
      </div>

      {/* Global floating assistant — collapsible bottom-right FAB.
          Hidden on /assistant where the full-page version renders to
          avoid a double mount (two conversation state machines, two
          fetches). The floating variant manages its own open/closed
          state internally; closed state is a small 56x56 bubble that
          doesn't block page content. On /messages (which has its own
          Teams compose) the panel's mobile-keyboard coverage was
          previously a problem; that's now fixed at the panel level
          (min(32rem, calc(100dvh - 2rem)) + onFocus scrollIntoView)
          so the FAB can appear on every page again. */}
      {pathname !== "/assistant" && pathname !== "/messages" && (
        <>
          <InstinctChat position="floating" />
          <WelcomeTooltip />
        </>
      )}
      {/* New-message slide-in toast — fires whenever the Teams unread
          count grows during this session. Self-suppresses on /messages
          (the user's already there). Self-renders nothing when count
          isn't growing — costs ~1 poll piggybacking on the existing
          adaptive-poll cadence. */}
      <NewMessageToast />
    </div>
  );
}
