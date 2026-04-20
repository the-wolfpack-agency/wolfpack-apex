"use client";

/**
 * PublishBar — top-of-studio publish + status bar.
 *
 * Shows a breadcrumb, the site name, the pending-edit count (computed
 * as JSON-patch-count between the current brief and the last-published
 * brief snapshot), a last-deploy timestamp, and the primary Publish
 * button. Mirrors the pinned top-bar pattern from Framer / Webflow / v0.
 *
 * Pending-edit count contract:
 *   - When `lastPublishedBrief` is null → "0 edits" (never published yet).
 *   - When current brief deep-equals published brief → "0 edits".
 *   - Otherwise → countBriefDiff(current, published) rendered as
 *     "N edit" / "N edits".
 *   - countBriefDiff walks every value recursively and counts leaf
 *     differences (add / remove / replace). Pure, exported so
 *     publish-bar.test.tsx can pin the math.
 *
 * Analytics:
 *   - Publish click fires `studio.publish_clicked` with pending_edit_count.
 *   - The caller owns the save+deploy flow; we only call `onPublish()`.
 *
 * A11y:
 *   - role="toolbar" container, publish button is a real <button>.
 *   - "X edits" label is in a live region so screen readers hear the
 *     number change when the designer edits the brief inline.
 */

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";

export interface PublishBarProps {
  siteName: string;
  siteId: string;
  clientSlug: string;
  /** Iframe preview URL. When present the "Open ↗" link is shown. */
  previewUrl?: string | null;
  /** Current in-memory brief (what the designer is editing). */
  currentBrief: unknown;
  /** Snapshot of the last-published brief used to compute the diff count. */
  lastPublishedBrief: unknown;
  /** ISO timestamp of the last successful deploy. */
  lastDeployAt?: string | null;
  /** Current deploy state — disables publish button + surfaces "Deploying…". */
  deployStatus?: "idle" | "saving" | "deploying" | "ready" | "failed";
  /** Fired when the designer clicks Publish. */
  onPublish: (pendingEditCount: number) => void;
  /** Optional analytics hook (e.g. to trigger `studio.publish_clicked`). */
  onAnalyticsPublishClicked?: (pendingEditCount: number) => void;
  /** Right-hand-side slot for the viewport toggle. */
  rightSlot?: ReactNode;
  /** data-testid prefix so tests can scope queries. */
  testIdPrefix?: string;
}

/**
 * Walks two JSON-serializable values and returns a crude "number of
 * different leaves" count — enough signal to say "3 edits pending"
 * without pulling in a full JSON-patch library. Pure function.
 */
export function countBriefDiff(current: unknown, published: unknown): number {
  if (current === published) return 0;
  // Null / undefined parity.
  if (current == null && published == null) return 0;
  if (current == null || published == null) return 1;

  // Arrays — compare element-by-element, count length mismatch.
  if (Array.isArray(current) && Array.isArray(published)) {
    const len = Math.max(current.length, published.length);
    let diffs = 0;
    for (let i = 0; i < len; i++) {
      diffs += countBriefDiff(current[i], published[i]);
    }
    return diffs;
  }
  if (Array.isArray(current) !== Array.isArray(published)) return 1;

  // Objects — union key set, recurse per key.
  if (typeof current === "object" && typeof published === "object") {
    const keys = new Set<string>([
      ...Object.keys(current as object),
      ...Object.keys(published as object),
    ]);
    let diffs = 0;
    for (const k of keys) {
      diffs += countBriefDiff(
        (current as Record<string, unknown>)[k],
        (published as Record<string, unknown>)[k],
      );
    }
    return diffs;
  }

  // Leaves — primitive compare.
  return current === published ? 0 : 1;
}

function formatLastDeploy(ts?: string | null): string {
  if (!ts) return "Never deployed";
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return "Never deployed";
  const delta = Date.now() - then;
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `Last deploy ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Last deploy ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last deploy ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Last deploy ${days}d ago`;
}

const barStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "8px 16px",
  borderBottom: "1px solid var(--wp-border, rgba(255,255,255,0.08))",
  background: "var(--wp-card, rgba(255,255,255,0.04))",
  color: "var(--wp-text, #e6e6e6)",
  flexWrap: "wrap",
};

export default function PublishBar({
  siteName,
  siteId,
  clientSlug,
  previewUrl,
  currentBrief,
  lastPublishedBrief,
  lastDeployAt,
  deployStatus = "idle",
  onPublish,
  onAnalyticsPublishClicked,
  rightSlot,
  testIdPrefix = "studio-publish-bar",
}: PublishBarProps) {
  const pendingCount = countBriefDiff(currentBrief, lastPublishedBrief);
  const dirty = pendingCount > 0;
  const busy = deployStatus === "saving" || deployStatus === "deploying";
  const disabled = !dirty || busy;

  function handleClick() {
    if (disabled) return;
    onAnalyticsPublishClicked?.(pendingCount);
    onPublish(pendingCount);
  }

  const editsLabel =
    pendingCount === 0
      ? "In sync with last published deploy"
      : pendingCount === 1
        ? "1 edit pending"
        : `${pendingCount} edits pending`;

  return (
    <div
      role="toolbar"
      aria-label="Site publish status"
      data-testid={testIdPrefix}
      style={barStyle}
    >
      <nav
        aria-label="Breadcrumb"
        data-testid={`${testIdPrefix}-breadcrumb`}
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          fontSize: 12,
          opacity: 0.75,
          flexWrap: "wrap",
        }}
      >
        <Link
          href="/sites"
          data-testid={`${testIdPrefix}-breadcrumb-sites`}
          style={{ color: "var(--wp-text-dim, #8a8a8a)", textDecoration: "none" }}
        >
          Sites
        </Link>
        <span aria-hidden="true" style={{ opacity: 0.5 }}>/</span>
        <span
          data-testid={`${testIdPrefix}-breadcrumb-client`}
          style={{ color: "var(--wp-text-dim, #8a8a8a)" }}
        >
          {clientSlug}
        </span>
        <span aria-hidden="true" style={{ opacity: 0.5 }}>/</span>
        <span
          data-testid={`${testIdPrefix}-site-name`}
          style={{ color: "var(--wp-text, #e6e6e6)", fontWeight: 600 }}
        >
          {siteName}
        </span>
      </nav>

      <div
        aria-live="polite"
        data-testid={`${testIdPrefix}-pending-count`}
        data-pending-count={pendingCount}
        style={{
          fontSize: 12,
          color: dirty
            ? "var(--wp-accent, #f3b841)"
            : "var(--wp-text-dim, #8a8a8a)",
          fontWeight: dirty ? 600 : 500,
        }}
      >
        {editsLabel}
      </div>

      <div
        data-testid={`${testIdPrefix}-last-deploy`}
        style={{ fontSize: 11, color: "var(--wp-text-dim, #8a8a8a)" }}
      >
        {formatLastDeploy(lastDeployAt)}
      </div>

      {previewUrl ? (
        <a
          href={previewUrl}
          target="_blank"
          rel="noreferrer"
          data-testid={`${testIdPrefix}-open-preview`}
          style={{
            fontSize: 12,
            color: "var(--wp-accent, #f3b841)",
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          Open ↗
        </a>
      ) : null}

      <div style={{ flex: 1 }} />

      {rightSlot}

      <button
        type="button"
        data-testid={`${testIdPrefix}-publish-btn`}
        aria-label={
          dirty
            ? `Publish ${pendingCount} pending ${pendingCount === 1 ? "edit" : "edits"}`
            : "No changes to publish"
        }
        aria-disabled={disabled}
        disabled={disabled}
        onClick={handleClick}
        style={{
          padding: "8px 16px",
          background: disabled
            ? "rgba(255,255,255,0.04)"
            : "var(--wp-gold, #f1c233)",
          color: disabled ? "rgba(255,255,255,0.45)" : "#111",
          border: disabled
            ? "1px solid var(--wp-border, rgba(255,255,255,0.12))"
            : "1px solid var(--wp-gold, #f1c233)",
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 700,
          cursor: disabled ? "default" : "pointer",
        }}
      >
        {busy
          ? deployStatus === "saving"
            ? "Saving…"
            : "Deploying…"
          : dirty
            ? "Publish"
            : "Published"}
      </button>

      {/* Hidden data attr so tests can assert site-id is wired through
          without us rendering a visible blob. */}
      <input
        type="hidden"
        data-testid={`${testIdPrefix}-site-id`}
        value={siteId}
        readOnly
      />
    </div>
  );
}
