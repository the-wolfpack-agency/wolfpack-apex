"use client";

/**
 * CommandPalette — Cmd+K / Ctrl+K route navigator.
 *
 * Mounts at the dashboard layout level. Listens for Cmd+K / Ctrl+K
 * globally (when no input is focused) to toggle. Filters NAV_ITEMS
 * by query as the user types. Arrow keys + Enter to navigate, Esc
 * to close.
 *
 * Routes are role-filtered using the same gate as the sidebar so an
 * `ops` user doesn't get an Enter-key shortcut to /financials.
 *
 * Accessibility:
 *   - role="dialog" + aria-modal
 *   - listbox + aria-activedescendant for the result list
 *   - focus trap on the input on open; restore focus to opener on close
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { NAV_ITEMS, canSeeNavItem, type NavItem } from "@/lib/dashboard-nav";

interface Props {
  /** User's role — controls which NAV_ITEMS are reachable. */
  role?: string | null;
  /** User's email — gates email-restricted items (e.g. Invoices). */
  email?: string | null;
}

function visibleFor(role: string | null | undefined, email: string | null | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => canSeeNavItem(item, role ?? "", email));
}

function filterByQuery(items: NavItem[], q: string): NavItem[] {
  const norm = q.trim().toLowerCase();
  if (!norm) return items;
  return items.filter(
    (i) =>
      i.label.toLowerCase().includes(norm) ||
      i.href.toLowerCase().includes(norm),
  );
}

export default function CommandPalette({ role, email }: Props) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  const allItems = useMemo(() => visibleFor(role, email), [role, email]);
  const items = useMemo(() => filterByQuery(allItems, query), [allItems, query]);

  // Open / close on Cmd+K / Ctrl+K, close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isToggle =
        (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isToggle) {
        // Don't intercept when the user is typing in a different
        // input that uses Cmd+K (none currently — but stay safe).
        const target = e.target as HTMLElement | null;
        const isEditable =
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable);
        if (isEditable && !open) return;
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Manage focus + reset query on open/close.
  useEffect(() => {
    if (open) {
      lastFocusedRef.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setActiveIndex(0);
      // Defer to next tick so the input has rendered.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    lastFocusedRef.current?.focus?.();
  }, [open]);

  // Keep the highlighted result valid as the filter shrinks.
  useEffect(() => {
    if (activeIndex >= items.length) {
      setActiveIndex(Math.max(0, items.length - 1));
    }
  }, [items.length, activeIndex]);

  const navigate = useCallback(
    (item: NavItem) => {
      setOpen(false);
      router.push(item.href);
    },
    [router],
  );

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (items.length === 0 ? 0 : (i + 1) % items.length));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) =>
        items.length === 0 ? 0 : (i - 1 + items.length) % items.length,
      );
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = items[activeIndex];
      if (item) navigate(item);
    }
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labeledby={`${id}-label`}
      data-testid="command-palette"
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        className="w-full max-w-xl rounded-xl border overflow-hidden wp-pop-in"
        style={{
          background: "var(--wp-dark-surface)",
          borderColor: "var(--wp-dark-border)",
          boxShadow: "0 16px 40px -12px rgba(0,0,0,0.5)",
        }}
      >
        <label htmlFor={`${id}-input`} id={`${id}-label`} className="sr-only">
          Search Instinct routes
        </label>
        <div
          className="flex items-center gap-3 px-4 py-3 border-b"
          style={{ borderColor: "var(--wp-dark-border)" }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            style={{ color: "var(--wp-text-dim)", flexShrink: 0 }}
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            id={`${id}-input`}
            data-testid="command-palette-input"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onInputKey}
            placeholder="Jump to anywhere..."
            className="flex-1 bg-transparent outline-none text-sm"
            style={{ color: "var(--wp-text)" }}
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={items[activeIndex] ? `${id}-opt-${activeIndex}` : undefined}
          />
          <span className="wp-kbd" aria-hidden>esc</span>
        </div>

        <ul
          id={`${id}-list`}
          role="listbox"
          data-testid="command-palette-list"
          className="max-h-80 overflow-y-auto py-1"
        >
          {items.length === 0 && (
            <li
              className="px-4 py-3 text-sm"
              style={{ color: "var(--wp-text-muted)" }}
              data-testid="command-palette-empty"
            >
              No matches for &quot;{query}&quot;.
            </li>
          )}
          {items.map((item, idx) => {
            const active = idx === activeIndex;
            return (
              <li
                key={item.href}
                id={`${id}-opt-${idx}`}
                role="option"
                aria-selected={active}
                data-testid={`command-palette-item-${idx}`}
                data-href={item.href}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => navigate(item)}
                className="flex items-center justify-between px-4 py-2 cursor-pointer"
                style={{
                  background: active ? "var(--wp-dark-surface2)" : "transparent",
                  borderLeft: `3px solid ${active ? "var(--wp-gold)" : "transparent"}`,
                  paddingLeft: "calc(1rem - 3px)",
                }}
              >
                <span className="text-sm font-medium" style={{ color: "var(--wp-text)" }}>
                  {item.label}
                </span>
                <span className="text-xs" style={{ color: "var(--wp-text-muted)" }}>
                  {item.href}
                </span>
              </li>
            );
          })}
        </ul>

        <div
          className="flex items-center justify-between px-4 py-2 text-xs border-t"
          style={{
            color: "var(--wp-text-muted)",
            borderColor: "var(--wp-dark-border)",
            background: "var(--wp-dark)",
          }}
        >
          <span className="flex items-center gap-2">
            <span className="wp-kbd">↑</span>
            <span className="wp-kbd">↓</span>
            <span>navigate</span>
          </span>
          <span className="flex items-center gap-2">
            <span className="wp-kbd">↵</span>
            <span>open</span>
          </span>
          <span className="flex items-center gap-2">
            <span className="wp-kbd">⌘</span>
            <span className="wp-kbd">K</span>
            <span>toggle</span>
          </span>
        </div>
      </div>
    </div>
  );
}
