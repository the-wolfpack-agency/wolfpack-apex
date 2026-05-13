"use client";

import { useState, useEffect, ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  getInstinctToken,
  getInstinctUser,
  setInstinctSession,
  clearInstinctSession,
  fetchWithRefresh,
  migrateLegacyApexKeys,
} from "@/lib/client-auth";
import NotificationBell from "@/components/NotificationBell";
import TeamsUnreadBadge from "@/components/TeamsUnreadBadge";
import NewMessageToast from "@/components/NewMessageToast";
import MessagesNavBadge from "@/components/MessagesNavBadge";
/* EmailNavBadge import removed — Emails route is hidden from the
   nav until the inbox is production-ready, so the badge has nothing
   to attach to and the unread-count poll is dead weight. */
import InstinctChat from "@/components/InstinctChat";
import WelcomeTooltip from "@/components/WelcomeTooltip";
import CommandPalette from "@/components/ui/CommandPalette";
import { useAmbientRefresh } from "@/lib/hooks/useAmbientRefresh";
import { useEmailArrivalPoll } from "@/lib/hooks/useEmailArrivalPoll";
import { NAV_ITEMS, PINNED_NAV_HREFS } from "@/lib/dashboard-nav";

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

/* NAV_ITEMS + PINNED_NAV_HREFS now live in src/lib/dashboard-nav.ts so
   the sidebar and the Cmd+K palette consume the same source. */

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
  /* Per-user nav prefs. Hidden hrefs are filtered out of the rendered
     sidebar. Lazy-loaded after auth so unauthenticated visitors don't
     fire the API call. Empty array = current behavior (show all). */
  const [hiddenHrefs, setHiddenHrefs] = useState<string[]>([]);
  const [navCustomizerOpen, setNavCustomizerOpen] = useState(false);

  // Ambient RAG refresh orchestrator (Path C · Stream U6). Silent by
  // design — runs a session-start warm pass of recent cached queries
  // and an idle-driven stale refresh loop. No UI, no prompts. Mounts
  // once here so every dashboard route benefits.
  useAmbientRefresh();

  // Silent email-arrival poll. Fires `email_arrived` notifications
  // to the top-right bell whenever new mail comes in (with a webLink
  // to the user's Outlook mailbox). Replaces what EmailNavBadge used
  // to drive before the badge was hidden from the sidebar.
  useEmailArrivalPoll();

  useEffect(() => {
    migrateLegacyApexKeys();

    let cancelled = false;
    (async () => {
      let token = getInstinctToken();
      let parsed = getInstinctUser<User>();
      /* Always call /api/auth/whoami on mount. Two responsibilities:
         - Microsoft sign-in flow: when localStorage is empty but the
           HttpOnly cookie is set, hydrate the client-side session.
         - Stale-id self-heal: if a prior migration deduplicated team
           members and reissued ids, /whoami re-mints the JWT under
           the canonical id and we replace the localStorage entries.
           Otherwise observations queries return empty (subject_user_id
           mismatch) until manual sign-out + sign-in. */
      try {
        const res = await fetch("/api/auth/whoami", {
          credentials: "include",
        });
        if (res.ok) {
          const data = (await res.json()) as { token: string; user: User };
          if (data?.token && data?.user) {
            const stale =
              !parsed ||
              !token ||
              parsed.id !== data.user.id ||
              token !== data.token;
            if (stale) {
              setInstinctSession(data.token, data.user);
              token = data.token;
              parsed = data.user;
            }
          }
        }
      } catch {
        /* Network blip — fall through to whatever localStorage has. */
      }
      if (cancelled) return;
      if (!token || !parsed) {
        router.push("/login");
        return;
      }
      setUser(parsed);
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Load per-user nav prefs once we have a token. Fire-and-forget; on
  // any failure we fall through with the default (all visible) so a
  // bad fetch doesn't block dashboard render.
  useEffect(() => {
    if (!user) return;
    void fetchWithRefresh("/api/user-nav-prefs")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { hiddenHrefs?: string[] } | null) => {
        if (data && Array.isArray(data.hiddenHrefs)) {
          setHiddenHrefs(data.hiddenHrefs);
        }
      })
      .catch(() => undefined);
  }, [user]);

  async function saveNavPrefs(next: string[]) {
    /* Optimistic update — UI flips immediately; rollback if PUT fails. */
    const prev = hiddenHrefs;
    setHiddenHrefs(next);
    try {
      const res = await fetchWithRefresh("/api/user-nav-prefs", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hiddenHrefs: next }),
      });
      if (!res.ok) throw new Error(`PUT ${res.status}`);
    } catch {
      setHiddenHrefs(prev);
    }
  }

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
        <div className="text-sm" style={{ color: "var(--wp-text-dim)" }}>Loading Instinct…</div>
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
          {NAV_ITEMS.filter(
            (item) =>
              (!item.roles || item.roles.includes(user.role)) &&
              !hiddenHrefs.includes(item.href),
          ).map((item) => {
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
                className={`wp-nav-item flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium ${active ? "wp-nav-item--active" : ""}`}
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
              </a>
            );
          })}

          {/* Customize nav — opens the checkbox modal. */}
          <button
            type="button"
            onClick={() => setNavCustomizerOpen(true)}
            data-testid="nav-customize-btn"
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors hover:opacity-80 mt-2"
            style={{
              background: "transparent",
              color: "var(--wp-text-muted)",
            }}
          >
            <svg
              className="w-5 h-5 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
            </svg>
            Customize nav
          </button>
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

      {/* Customize-nav modal */}
      {navCustomizerOpen ? (
        <NavCustomizerModal
          allItems={NAV_ITEMS.filter(
            (item) => !item.roles || item.roles.includes(user.role),
          )}
          hiddenHrefs={hiddenHrefs}
          onSave={async (next) => {
            await saveNavPrefs(next);
            setNavCustomizerOpen(false);
          }}
          onClose={() => setNavCustomizerOpen(false)}
        />
      ) : null}

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
      {/* Cmd+K / Ctrl+K command palette — global navigator. Renders
          nothing until toggled. Role-filters routes the user can't
          reach, mirroring the sidebar's gate. */}
      <CommandPalette role={user?.role ?? null} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Nav customizer — checkbox modal                                     */
/* ------------------------------------------------------------------ */

interface NavCustomizerModalProps {
  allItems: { label: string; href: string; icon: string; roles?: string[] }[];
  hiddenHrefs: string[];
  onSave: (nextHidden: string[]) => Promise<void> | void;
  onClose: () => void;
}

function NavCustomizerModal({
  allItems,
  hiddenHrefs,
  onSave,
  onClose,
}: NavCustomizerModalProps) {
  /* Local draft set so toggling doesn't fire a save per click; only
     the Save button persists. The draft starts as the current hidden
     set so unmounting without saving discards changes cleanly. */
  const [draft, setDraft] = useState<Set<string>>(new Set(hiddenHrefs));
  const [busy, setBusy] = useState(false);

  function toggle(href: string) {
    if (PINNED_NAV_HREFS.includes(href)) return; // can't hide pinned
    const next = new Set(draft);
    if (next.has(href)) next.delete(href);
    else next.add(href);
    setDraft(next);
  }

  async function handleSave() {
    setBusy(true);
    try {
      await onSave(Array.from(draft));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
      data-testid="nav-customizer-overlay"
    >
      <div
        className="w-full max-w-md rounded-lg border flex flex-col max-h-[80vh]"
        style={{
          background: "var(--wp-dark-surface)",
          borderColor: "var(--wp-dark-border)",
        }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Customize nav"
        data-testid="nav-customizer-modal"
      >
        <div
          className="px-5 py-3 border-b flex items-center justify-between"
          style={{ borderColor: "var(--wp-dark-border)" }}
        >
          <h2
            className="text-sm font-semibold"
            style={{ color: "var(--wp-gold)" }}
          >
            Customize left nav
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-xs"
            style={{ color: "var(--wp-text-muted)" }}
            aria-label="Close customize nav"
          >
            ✕
          </button>
        </div>
        <div className="px-5 py-3 text-xs" style={{ color: "var(--wp-text-muted)" }}>
          Uncheck items to hide them from your sidebar. Dashboard and
          Settings stay visible so you always have a recovery path.
        </div>
        <ul
          className="flex-1 overflow-y-auto px-5 py-2 space-y-1"
          data-testid="nav-customizer-list"
        >
          {allItems.map((item) => {
            const pinned = PINNED_NAV_HREFS.includes(item.href);
            const visible = !draft.has(item.href);
            return (
              <li
                key={item.href}
                className="flex items-center gap-2 px-2 py-1 rounded text-sm"
                style={{
                  color: pinned ? "var(--wp-text-muted)" : "var(--wp-text)",
                  opacity: pinned ? 0.7 : 1,
                }}
              >
                <input
                  type="checkbox"
                  data-testid={`nav-customizer-item-${item.href}`}
                  disabled={pinned || busy}
                  checked={visible}
                  onChange={() => toggle(item.href)}
                  aria-label={`${visible ? "Hide" : "Show"} ${item.label}`}
                />
                <span className="flex-1">{item.label}</span>
                {pinned ? (
                  <span
                    className="text-xs"
                    style={{ color: "var(--wp-text-muted)" }}
                  >
                    pinned
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div
          className="px-5 py-3 border-t flex justify-end gap-2"
          style={{ borderColor: "var(--wp-dark-border)" }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 rounded text-xs"
            style={{
              background: "var(--wp-dark-surface2)",
              color: "var(--wp-text)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={busy}
            data-testid="nav-customizer-save"
            className="px-3 py-1.5 rounded text-xs font-medium"
            style={{
              background: "var(--wp-gold)",
              color: "var(--wp-dark)",
            }}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
