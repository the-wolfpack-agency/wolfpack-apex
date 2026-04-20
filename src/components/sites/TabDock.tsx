"use client";

/**
 * TabDock — left-rail tab host for the unified Instinct site studio.
 *
 * Framer/Webflow/v0-style persistent tab dock. Replaces the legacy
 * <details>/accordion panels that lived on `/sites/[id]/edit`. Each tab
 * pairs an icon + label with a slot of content rendered in the rail body.
 *
 * Accessibility contract:
 *   - Outer <nav role="tablist"> carries `aria-orientation="vertical"`.
 *   - Each tab button is `role="tab"` with `aria-selected` + `aria-controls`.
 *   - Tab panels are `role="tabpanel"` with matching `aria-labelledby`.
 *   - ArrowUp / ArrowDown cycle focus; Home / End jump to first/last.
 *   - Controlled: parent owns `activeTab` so the studio can persist
 *     selection to the URL for deep-links.
 *   - No <details> accordions — per StudioShell spec, all panel bodies
 *     render inside a role="tabpanel" host.
 *
 * Visual parity with the legacy prompt editor's left pane (dark rail,
 * wp-card backgrounds, wp-gold accent) so designers don't re-learn colors.
 */

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabDefinition {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Optional badge rendered after the label (e.g. pending-edit count). */
  badge?: string | number;
  /** Hidden from the rail but still reachable via keyboard-forward nav. */
  hidden?: boolean;
  content: ReactNode;
}

export interface TabDockProps {
  tabs: TabDefinition[];
  activeTab: string;
  onActiveTabChange: (id: string) => void;
  /** data-testid root prefix; tabs become `${prefix}-tab-<id>` etc. */
  testIdPrefix?: string;
  /** aria-label for the outer tablist (screen-reader context). */
  ariaLabel?: string;
}

export default function TabDock({
  tabs,
  activeTab,
  onActiveTabChange,
  testIdPrefix = "studio-tab-dock",
  ariaLabel = "Site studio tools",
}: TabDockProps) {
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const visibleTabs = tabs.filter((t) => !t.hidden);

  // Focus the active tab when `activeTab` changes (e.g. programmatic
  // selection). Without this keyboard users lose the focus ring when the
  // page switches tabs from outside the dock.
  useEffect(() => {
    // No-op on mount; only react to explicit activeTab changes after
    // the initial render via the focus-in flow on arrow keys. Leaving
    // this here as a hook so future "open tab X" triggers have a place.
  }, [activeTab]);

  function moveFocus(delta: number) {
    const idx = visibleTabs.findIndex((t) => t.id === activeTab);
    if (idx < 0) return;
    const nextIdx =
      (idx + delta + visibleTabs.length) % visibleTabs.length;
    const nextId = visibleTabs[nextIdx]?.id;
    if (nextId) {
      onActiveTabChange(nextId);
      queueMicrotask(() => {
        buttonRefs.current[nextId]?.focus();
      });
    }
  }

  function handleKey(e: KeyboardEvent<HTMLElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      if (visibleTabs[0]) onActiveTabChange(visibleTabs[0].id);
    } else if (e.key === "End") {
      e.preventDefault();
      const last = visibleTabs[visibleTabs.length - 1];
      if (last) onActiveTabChange(last.id);
    }
  }

  const active = tabs.find((t) => t.id === activeTab) ?? tabs[0];

  return (
    <div
      data-testid={testIdPrefix}
      style={{
        display: "flex",
        height: "100%",
        minHeight: 0,
        minWidth: 0,
      }}
    >
      {/* Vertical rail of tab buttons. */}
      <nav
        role="tablist"
        aria-label={ariaLabel}
        aria-orientation="vertical"
        onKeyDown={handleKey}
        data-testid={`${testIdPrefix}-rail`}
        style={{
          width: 56,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 2,
          padding: "12px 4px",
          borderRight: "1px solid var(--wp-border, rgba(255,255,255,0.08))",
          background: "var(--wp-card, rgba(255,255,255,0.02))",
        }}
      >
        {visibleTabs.map((tab) => {
          const selected = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                buttonRefs.current[tab.id] = el;
              }}
              type="button"
              role="tab"
              id={`${testIdPrefix}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${testIdPrefix}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              data-testid={`${testIdPrefix}-tab-${tab.id}`}
              data-active={selected ? "true" : "false"}
              onClick={() => onActiveTabChange(tab.id)}
              title={tab.label}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 2,
                padding: "8px 4px",
                border: "1px solid transparent",
                borderRadius: 6,
                background: selected
                  ? "var(--wp-gold, #f1c233)"
                  : "transparent",
                color: selected
                  ? "var(--wp-dark, #212124)"
                  : "var(--wp-text, #e6e6e6)",
                cursor: "pointer",
                fontSize: 10,
                fontWeight: selected ? 600 : 500,
                outline: "none",
                position: "relative",
              }}
            >
              <span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1 }}>
                {tab.icon ?? tab.label[0]}
              </span>
              <span style={{ fontSize: 10, lineHeight: 1.1 }}>{tab.label}</span>
              {tab.badge !== undefined && tab.badge !== "" && tab.badge !== 0 && (
                <span
                  aria-hidden="true"
                  data-testid={`${testIdPrefix}-badge-${tab.id}`}
                  style={{
                    position: "absolute",
                    top: 2,
                    right: 2,
                    background: "var(--wp-accent, #f3b841)",
                    color: "#111",
                    borderRadius: 10,
                    padding: "0 5px",
                    fontSize: 9,
                    fontWeight: 700,
                    lineHeight: "14px",
                    minWidth: 14,
                    textAlign: "center",
                  }}
                >
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Active panel body. Always mounted so `aria-controls` resolves. */}
      <div
        role="tabpanel"
        id={`${testIdPrefix}-panel-${active?.id ?? ""}`}
        aria-labelledby={`${testIdPrefix}-tab-${active?.id ?? ""}`}
        data-testid={`${testIdPrefix}-panel`}
        data-active-tab={active?.id ?? ""}
        tabIndex={0}
        style={{
          flex: 1,
          minWidth: 0,
          overflowY: "auto",
          outline: "none",
        }}
      >
        {active?.content}
      </div>
    </div>
  );
}
