/**
 * ConsoleShell — the page-level frame every console surface sits in.
 *
 * WHY THIS EXISTS. The kit had primitives (GlassPanel, MetricTile, StatusPill)
 * and no agreement about the page AROUND them. /admin/ai-router and
 * /admin/agents each set their own container width, padding and heading
 * treatment inline, and /assistant used none of the kit at all. Three surfaces
 * a client moves between looked like three products.
 *
 * A shell is the cheapest way to fix that. It owns the frame and nothing else:
 * width, rhythm, the ambient backdrop, and an optional header. What goes
 * inside is entirely the page's business.
 *
 * THE BACKDROP IS THE ONLY NEW AESTHETIC, and it is deliberately faint. A
 * single soft gradient behind the content gives the glass panels something to
 * be glass against, which is what makes the existing backdrop-filter read as
 * depth rather than as a slightly grey box. Anything stronger competes with
 * the content, and this is a working surface people spend their day in rather
 * than a landing page.
 *
 * `fill` exists for the assistant, which is a conversation that owns the
 * viewport rather than a document that scrolls. A shell that forces its own
 * scroll container would break a chat surface, so it steps aside.
 */

"use client";

import type { ReactNode } from "react";
import { SectionHeader } from "./SectionHeader";

export interface ConsoleShellProps {
  /** Optional page heading, rendered through the kit's own header. */
  title?: ReactNode;
  subtitle?: ReactNode;
  eyebrow?: ReactNode;
  /** Right-aligned header actions. */
  actions?: ReactNode;
  /**
   * Fill the available height instead of flowing as a document.
   *
   * For surfaces that own the viewport, like a conversation. Without it the
   * shell would introduce a second scroll container and the chat would scroll
   * inside a page that also scrolls.
   */
  fill?: boolean;
  children: ReactNode;
  testId?: string;
}

export function ConsoleShell({
  title,
  subtitle,
  eyebrow,
  actions,
  fill = false,
  children,
  testId,
}: ConsoleShellProps) {
  const hasHeader = title != null || subtitle != null || eyebrow != null || actions != null;

  return (
    <div
      className={`wp-console-shell${fill ? " wp-console-shell-fill" : ""}`}
      data-testid={testId ?? "console-shell"}
    >
      {hasHeader && (
        <SectionHeader
          as="h1"
          {...(eyebrow != null ? { eyebrow } : {})}
          {...(title != null ? { title } : { title: "" })}
          {...(subtitle != null ? { subtitle } : {})}
          {...(actions != null ? { actions } : {})}
        />
      )}
      {/* min-height 0 so a filling child can scroll inside rather than
          stretching the shell and taking the page with it. */}
      <div className={fill ? "flex-1 min-h-0" : undefined}>{children}</div>
    </div>
  );
}

export default ConsoleShell;
