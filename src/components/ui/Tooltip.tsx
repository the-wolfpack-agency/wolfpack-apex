"use client";

/**
 * Tooltip — lightweight hover/focus tooltip.
 *
 * Built without portals on purpose: the trigger keeps the tooltip in
 * its own stacking context. Position is `top` by default; auto-flips
 * to `bottom` when there's not enough headroom in the viewport.
 *
 * Accessibility:
 *   - aria-describedby links the trigger to the tooltip element
 *   - Tooltip mounts on focus too, not just hover
 *   - Escape dismisses
 */

import React, { useEffect, useId, useRef, useState } from "react";

interface TooltipProps {
  label: React.ReactNode;
  /** Optional secondary line — keyboard hint, last-updated time, etc. */
  hint?: React.ReactNode;
  side?: "top" | "bottom";
  delayMs?: number;
  children: React.ReactElement;
}

export default function Tooltip({
  label,
  hint,
  side = "top",
  delayMs = 250,
  children,
}: TooltipProps) {
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [resolvedSide, setResolvedSide] = useState<"top" | "bottom">(side);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function show() {
    if (showTimer.current) clearTimeout(showTimer.current);
    showTimer.current = setTimeout(() => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (rect) {
        setResolvedSide(rect.top < 80 ? "bottom" : side);
      }
      setOpen(true);
    }, delayMs);
  }
  function hide() {
    if (showTimer.current) clearTimeout(showTimer.current);
    setOpen(false);
  }

  return (
    <span
      ref={triggerRef}
      style={{ position: "relative", display: "inline-flex" }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {React.cloneElement(children, { "aria-describedby": id } as Record<string, unknown>)}
      {open && (
        <span
          id={id}
          role="tooltip"
          data-testid="tooltip"
          className="wp-fade-in"
          style={{
            position: "absolute",
            zIndex: 60,
            ...(resolvedSide === "top"
              ? { bottom: "calc(100% + 8px)" }
              : { top: "calc(100% + 8px)" }),
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--wp-dark)",
            color: "var(--wp-text)",
            border: "1px solid var(--wp-dark-border)",
            borderRadius: 6,
            padding: "6px 10px",
            fontSize: 12,
            lineHeight: 1.35,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            boxShadow: "0 6px 16px -6px rgba(0,0,0,.5)",
          }}
        >
          <span style={{ display: "block", color: "var(--wp-text)" }}>{label}</span>
          {hint && (
            <span style={{ display: "block", marginTop: 2, color: "var(--wp-text-muted)", fontSize: 11 }}>
              {hint}
            </span>
          )}
        </span>
      )}
    </span>
  );
}
