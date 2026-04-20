"use client";

/**
 * StudioShell — unified site studio layout.
 *
 * THREE-PANE LAYOUT modeled after Framer / Webflow / v0:
 *
 *   ┌────────────────── PublishBar (breadcrumb · pending count · Publish) ──┐
 *   │ TabDock │              Center preview iframe            │ Inspector   │
 *   │ (rail)  │  Chat / Sections / Theme / Assets / SEO /      │ (right rail)│
 *   │         │  Forms / Domain / Share / Versions / Comments  │             │
 *   └─────────┴────────────────────────────────────────────────┴─────────────┘
 *
 * The left-rail tab panels host what used to be the legacy <details>
 * accordions on `/sites/[id]/edit`. We DO NOT modify those child
 * components (AssetLibraryPicker, ThemeEditor, DomainManager, etc.) —
 * we just move them into the TabDock as tabpanels.
 *
 * Poll stability:
 *   - The parent (the page that mounts StudioShell) owns the
 *     `load({ fromPoll })` state machine and passes the current
 *     `brief` + `savedBrief` + `lastPublishedBrief` + `deployStatus`
 *     down. The shell itself is a presentational component.
 *   - sites-detail-poll-stability.test.tsx is a harness test — it
 *     doesn't touch this file, but it enforces the pattern we follow
 *     in the page.
 *
 * Analytics: the shell fires every `studio.*` event in analytics.ts.
 * See the `trackEvent` callback prop.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Brief } from "@/components/sites/BriefForm";
import type { BriefSection, SiteBrief } from "@/lib/sites-schema";
import {
  applyInlineReorder,
  encodeBriefPush,
} from "@/lib/preview-postmessage";
import ViewportToggle, {
  VIEWPORT_WIDTHS,
  type Viewport,
} from "@/components/sites/ViewportToggle";
import TabDock, { type TabDefinition } from "@/components/sites/TabDock";
import SectionOutline, {
  type SectionTypeLite,
} from "@/components/sites/SectionOutline";
import InspectorPanel from "@/components/sites/InspectorPanel";
import PublishBar from "@/components/sites/PublishBar";

export type StudioAnalyticsEvent =
  | "studio.opened"
  | "studio.tab_changed"
  | "studio.section_selected"
  | "studio.section_reordered"
  | "studio.section_duplicated"
  | "studio.section_deleted"
  | "studio.section_added"
  | "studio.inspector_field_edited"
  | "studio.publish_clicked";

export interface StudioShellProps {
  siteId: string;
  siteName: string;
  clientSlug: string;
  /** Current in-memory brief. Parent owns this state. */
  brief: Brief;
  /** Last server-saved brief — null until first load completes. */
  savedBrief: Brief | null;
  /** Last published brief snapshot used for the diff count. */
  lastPublishedBrief: Brief | null;
  /** Last deploy timestamp (ISO). */
  lastDeployAt?: string | null;
  /** Deploy status mirrored from the project record. */
  deployStatus?: "idle" | "saving" | "deploying" | "ready" | "failed";
  /** Preview URL used by the top-bar "Open ↗" link (when a deploy succeeded). */
  previewUrl?: string | null;
  /** Controlled update — shell emits the next brief (already-merged). */
  onBriefChange: (next: Brief) => void;
  /** User clicked Publish. Parent runs save + deploy. */
  onPublish: (pendingEditCount: number) => void;
  /**
   * Caller-provided tab contents for everything that ISN'T "Sections"
   * — Chat, Theme, Assets, SEO, Forms, Domain, Share, Versions,
   * Comments. The shell is intentionally agnostic about what goes in
   * those tabs; the page passes existing components through.
   */
  tabContent: {
    chat: ReactNode;
    theme: ReactNode;
    assets: ReactNode;
    seo: ReactNode;
    forms: ReactNode;
    domain: ReactNode;
    share: ReactNode;
    versions: ReactNode;
    comments: ReactNode;
  };
  /** Fires for every studio.* analytics event. */
  onAnalytics?: (
    event: StudioAnalyticsEvent,
    metadata: Record<string, string | number | boolean>,
  ) => void;
}

/**
 * Walks a slash-delimited field path and returns a new section with
 * the leaf replaced. Creates intermediate objects on demand so
 * `cta/label` works even when `cta` was previously undefined. Pure.
 */
export function setSectionField(
  section: BriefSection,
  path: string,
  value: string,
): BriefSection {
  const parts = path.split("/");
  const next = JSON.parse(JSON.stringify(section)) as BriefSection;
  let cur: Record<string, unknown> = next as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== "object") {
      cur[p] = {};
    }
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
  return next;
}

/** Build a new brief with section at `(pageIndex, sectionIndex)` replaced. */
export function replaceSectionInBrief(
  brief: Brief,
  pageIndex: number,
  sectionIndex: number,
  next: BriefSection,
): Brief {
  const clone = JSON.parse(JSON.stringify(brief)) as Brief;
  const page = clone.pages[pageIndex];
  if (!page) return brief;
  page.sections[sectionIndex] = next as unknown as Brief["pages"][number]["sections"][number];
  return clone;
}

/** Duplicate a section (deep clone, inserted immediately after). */
export function duplicateSectionInBrief(
  brief: Brief,
  pageIndex: number,
  sectionIndex: number,
): Brief {
  const clone = JSON.parse(JSON.stringify(brief)) as Brief;
  const page = clone.pages[pageIndex];
  if (!page) return brief;
  const src = page.sections[sectionIndex];
  if (!src) return brief;
  const dup = JSON.parse(JSON.stringify(src));
  page.sections.splice(sectionIndex + 1, 0, dup);
  return clone;
}

/** Remove a section. */
export function deleteSectionInBrief(
  brief: Brief,
  pageIndex: number,
  sectionIndex: number,
): Brief {
  const clone = JSON.parse(JSON.stringify(brief)) as Brief;
  const page = clone.pages[pageIndex];
  if (!page) return brief;
  page.sections.splice(sectionIndex, 1);
  return clone;
}

/** Append a new blank section of the given type. */
export function addSectionToBrief(
  brief: Brief,
  pageIndex: number,
  type: SectionTypeLite,
): Brief {
  const clone = JSON.parse(JSON.stringify(brief)) as Brief;
  const page = clone.pages[pageIndex];
  if (!page) return brief;
  const blank: Record<string, unknown> = { type };
  if (type === "stats") blank.items = [{ label: "", value: 0 }];
  if (type === "cards") blank.items = [{ title: "", body: "" }];
  if (type === "gallery") blank.images = [];
  if (type === "video") blank.autoplay = false;
  if (type === "testimonial") blank.items = [{ quote: "", authorName: "" }];
  if (type === "pricing") blank.items = [{ name: "", price: "", features: [] }];
  if (type === "faq") blank.items = [{ question: "", answer: "" }];
  page.sections.push(
    blank as unknown as Brief["pages"][number]["sections"][number],
  );
  return clone;
}

const TAB_IDS = [
  "chat",
  "sections",
  "theme",
  "assets",
  "seo",
  "forms",
  "domain",
  "share",
  "versions",
  "comments",
] as const;
export type StudioTabId = (typeof TAB_IDS)[number];

const TAB_ICONS: Record<StudioTabId, string> = {
  chat: "✦",
  sections: "≡",
  theme: "◐",
  assets: "◪",
  seo: "S",
  forms: "▭",
  domain: "⚑",
  share: "⤴",
  versions: "⟲",
  comments: "❝",
};

const TAB_LABELS: Record<StudioTabId, string> = {
  chat: "Chat",
  sections: "Sections",
  theme: "Theme",
  assets: "Assets",
  seo: "SEO",
  forms: "Forms",
  domain: "Domain",
  share: "Share",
  versions: "Versions",
  comments: "Comments",
};

export default function StudioShell({
  siteId,
  siteName,
  clientSlug,
  brief,
  savedBrief: _savedBrief,
  lastPublishedBrief,
  lastDeployAt,
  deployStatus = "idle",
  previewUrl,
  onBriefChange,
  onPublish,
  tabContent,
  onAnalytics,
}: StudioShellProps) {
  const [activeTab, setActiveTab] = useState<StudioTabId>("chat");
  const [selectedSectionIndex, setSelectedSectionIndex] = useState<number | null>(
    null,
  );
  const [viewport, setViewport] = useState<Viewport>("desktop");
  const [iframeNonce, setIframeNonce] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const openedFiredRef = useRef(false);

  // Fire studio.opened exactly once per mount. Using a ref (not state)
  // so StrictMode double-invoke in dev doesn't double-fire the event.
  useEffect(() => {
    if (openedFiredRef.current) return;
    openedFiredRef.current = true;
    onAnalytics?.("studio.opened", { site_id: siteId });
  }, [onAnalytics, siteId]);

  function handleTabChange(next: string) {
    const tabId = (TAB_IDS as readonly string[]).includes(next)
      ? (next as StudioTabId)
      : activeTab;
    if (tabId === activeTab) return;
    setActiveTab(tabId);
    onAnalytics?.("studio.tab_changed", {
      site_id: siteId,
      tab_name: tabId,
    });
  }

  // Push every brief change to the iframe via the typed brief.push
  // message contract in preview-postmessage.ts. Nonce-bump covers the
  // cold load; postMessage is the fast path on subsequent edits.
  useEffect(() => {
    try {
      const encoded = encodeBriefPush(brief);
      if (encoded && iframeRef.current?.contentWindow) {
        iframeRef.current.contentWindow.postMessage(
          JSON.parse(encoded),
          window.location.origin,
        );
      }
    } catch {
      /* non-fatal — the next nonce bump will reload the iframe */
    }
  }, [brief]);

  // Preview URL — encode the current in-memory brief so the iframe
  // renders the unsaved draft without a round-trip. Same semantics as
  // the legacy edit page (base64 of JSON + cache-busting nonce).
  const computedPreviewUrl = (() => {
    try {
      const encoded =
        typeof btoa === "function"
          ? btoa(unescape(encodeURIComponent(JSON.stringify(brief))))
          : Buffer.from(JSON.stringify(brief), "utf-8").toString("base64");
      if (encoded.length > 256 * 1024) {
        return `/sites/${siteId}/preview?t=${iframeNonce}`;
      }
      return `/sites/${siteId}/preview?draft=${encodeURIComponent(encoded)}&t=${iframeNonce}`;
    } catch {
      return `/sites/${siteId}/preview?t=${iframeNonce}`;
    }
  })();

  const activePage = brief.pages[0];
  const sections = (activePage?.sections ?? []) as unknown as BriefSection[];
  const selectedSection =
    selectedSectionIndex !== null
      ? sections[selectedSectionIndex] ?? null
      : null;

  // --- Section outline callbacks ---------------------------------------------

  function selectSection(index: number) {
    setSelectedSectionIndex(index);
    onAnalytics?.("studio.section_selected", {
      site_id: siteId,
      section_id: `${index}:${sections[index]?.type ?? "unknown"}`,
    });
  }

  function reorderSection(from: number, to: number) {
    const next = applyInlineReorder(brief as unknown as SiteBrief, {
      origin: "instinct.preview.v1",
      type: "section.reorder",
      pageIndex: 0,
      fromIndex: from,
      toIndex: to,
    });
    if (next === (brief as unknown as SiteBrief)) return;
    onBriefChange(next as unknown as Brief);
    setIframeNonce((n) => n + 1);
    setSelectedSectionIndex(to);
    onAnalytics?.("studio.section_reordered", {
      site_id: siteId,
      from_idx: from,
      to_idx: to,
    });
  }

  function duplicateSection(index: number) {
    const next = duplicateSectionInBrief(brief, 0, index);
    onBriefChange(next);
    setIframeNonce((n) => n + 1);
    onAnalytics?.("studio.section_duplicated", {
      site_id: siteId,
      section_id: `${index}:${sections[index]?.type ?? "unknown"}`,
    });
  }

  function deleteSection(index: number) {
    const next = deleteSectionInBrief(brief, 0, index);
    onBriefChange(next);
    setIframeNonce((n) => n + 1);
    if (selectedSectionIndex === index) setSelectedSectionIndex(null);
    onAnalytics?.("studio.section_deleted", {
      site_id: siteId,
      section_id: `${index}:${sections[index]?.type ?? "unknown"}`,
    });
  }

  function addSection(type: SectionTypeLite) {
    const next = addSectionToBrief(brief, 0, type);
    onBriefChange(next);
    setIframeNonce((n) => n + 1);
    onAnalytics?.("studio.section_added", {
      site_id: siteId,
      section_type: type,
    });
  }

  // --- Inspector callbacks ---------------------------------------------------

  function handleFieldChange(path: string, value: string) {
    if (selectedSectionIndex === null) return;
    const cur = sections[selectedSectionIndex];
    if (!cur) return;
    const patched = setSectionField(cur, path, value);
    const next = replaceSectionInBrief(brief, 0, selectedSectionIndex, patched);
    onBriefChange(next);
    onAnalytics?.("studio.inspector_field_edited", {
      site_id: siteId,
      field_path: path,
      section_id: `${selectedSectionIndex}:${cur.type}`,
    });
  }

  // --- Publish ---------------------------------------------------------------

  function handlePublishAnalytics(pendingEditCount: number) {
    onAnalytics?.("studio.publish_clicked", {
      site_id: siteId,
      pending_edit_count: pendingEditCount,
    });
  }

  // --- Tab definitions -------------------------------------------------------

  const sectionsTabBody = (
    <SectionOutline
      sections={sections}
      selectedIndex={selectedSectionIndex}
      onSelect={selectSection}
      onReorder={reorderSection}
      onDuplicate={duplicateSection}
      onDelete={deleteSection}
      onAddSection={addSection}
    />
  );

  const tabs: TabDefinition[] = TAB_IDS.map((id) => {
    let content: ReactNode;
    if (id === "sections") content = sectionsTabBody;
    else content = tabContent[id];
    return {
      id,
      label: TAB_LABELS[id],
      icon: TAB_ICONS[id],
      content,
    };
  });

  // --- Layout ----------------------------------------------------------------

  return (
    <div
      data-testid="studio-shell"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 64px)",
        minHeight: 0,
        color: "var(--wp-text, #e6e6e6)",
        background: "var(--wp-bg, #0f1115)",
      }}
    >
      <PublishBar
        siteName={siteName}
        siteId={siteId}
        clientSlug={clientSlug}
        previewUrl={previewUrl}
        currentBrief={brief}
        lastPublishedBrief={lastPublishedBrief}
        lastDeployAt={lastDeployAt}
        deployStatus={deployStatus}
        onPublish={onPublish}
        onAnalyticsPublishClicked={handlePublishAnalytics}
        rightSlot={<ViewportToggle value={viewport} onChange={setViewport} />}
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "clamp(320px, 28vw, 440px) 1fr clamp(280px, 22vw, 360px)",
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* LEFT — TabDock */}
        <aside
          style={{
            borderRight: "1px solid var(--wp-border, rgba(255,255,255,0.08))",
            minWidth: 0,
            minHeight: 0,
            overflow: "hidden",
          }}
          data-testid="studio-left-rail"
        >
          <TabDock
            tabs={tabs}
            activeTab={activeTab}
            onActiveTabChange={handleTabChange}
          />
        </aside>

        {/* CENTER — preview iframe */}
        <main
          data-testid="studio-center-pane"
          data-viewport={viewport}
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            minWidth: 0,
            background: "rgba(0,0,0,0.25)",
          }}
        >
          <div
            style={{
              padding: "8px 14px",
              borderBottom:
                "1px solid var(--wp-border, rgba(255,255,255,0.08))",
              display: "flex",
              gap: 10,
              alignItems: "center",
              fontSize: 11,
              color: "var(--wp-text-dim, #8a8a8a)",
            }}
          >
            <span>Preview · {VIEWPORT_WIDTHS[viewport]}px</span>
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflow: "auto",
              display: "flex",
              justifyContent: "center",
              padding: viewport === "desktop" ? 0 : 16,
            }}
            data-testid="studio-preview-canvas"
          >
            <div
              style={{
                width: "100%",
                maxWidth: `${VIEWPORT_WIDTHS[viewport]}px`,
                transition: "max-width 200ms ease",
                height: "100%",
                border:
                  viewport === "desktop"
                    ? "none"
                    : "1px solid var(--wp-border, rgba(255,255,255,0.12))",
                borderRadius: viewport === "desktop" ? 0 : 8,
                overflow: "hidden",
                background: "#fff",
                boxShadow:
                  viewport === "desktop"
                    ? "none"
                    : "0 2px 12px rgba(0,0,0,0.25)",
              }}
            >
              <iframe
                ref={iframeRef}
                key={iframeNonce}
                src={computedPreviewUrl}
                title="Live preview"
                data-testid="studio-preview-iframe"
                style={{
                  width: "100%",
                  height: "100%",
                  border: "none",
                  background: "#fff",
                  display: "block",
                }}
              />
            </div>
          </div>
        </main>

        {/* RIGHT — Inspector */}
        <aside
          data-testid="studio-right-rail"
          style={{
            borderLeft: "1px solid var(--wp-border, rgba(255,255,255,0.08))",
            overflowY: "auto",
            minWidth: 0,
            minHeight: 0,
            background: "var(--wp-card, rgba(255,255,255,0.02))",
          }}
        >
          <InspectorPanel
            section={selectedSection}
            sectionIndex={selectedSectionIndex}
            onFieldChange={handleFieldChange}
          />
        </aside>
      </div>
    </div>
  );
}
