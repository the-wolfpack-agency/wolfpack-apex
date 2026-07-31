"use client";

/**
 * EngineeringWiki: the /engineering wiki reader.
 *
 * Renders a hierarchical sidebar (built from parentSlug via buildTree) plus a
 * content pane that shows the selected page's breadcrumbs, title, and its body
 * (pre-rendered to sanitized HTML on the server as `bodyHtml`, so the client
 * never imports the Node-only sanitizer). Presentational only: the page owns the
 * fetch; this component just takes the page list.
 */

import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { WikiPage, WikiPageNode } from "@/lib/engineering-tree";
import { buildTree } from "@/lib/engineering-tree";
import AgenticQAPipeline from "./AgenticQAPipeline";

/**
 * Curated visual diagrams keyed by page slug. A page can pair a hand-built,
 * dependency-free diagram with its Markdown body (the renderer only emits text
 * HTML, so visuals live here as components). Rendered above the page body.
 */
const PAGE_DIAGRAMS: Record<string, ReactNode> = {
  "testing-and-quality": <AgenticQAPipeline />,
};

interface EngineeringWikiProps {
  pages: WikiPage[];
}

/** Recursively render one tree node and its descendants as indented nav buttons. */
function NavNode({
  node,
  depth,
  selectedSlug,
  onSelect,
}: {
  node: WikiPageNode;
  depth: number;
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
}) {
  const isSelected = node.slug === selectedSlug;
  return (
    <>
      {/* Real anchor so every page is linkable: hover shows the URL, right-click
          copies it, cmd/ctrl-click opens it in a new tab. onClick keeps the SPA
          behavior for a normal click. */}
      <a
        href={`?page=${node.slug}`}
        data-testid={`wiki-nav-${node.slug}`}
        onClick={(e) => {
          // Let modified clicks (new tab/window) use the real href.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          onSelect(node.slug);
        }}
        aria-current={isSelected ? "page" : undefined}
        style={{
          all: "unset",
          boxSizing: "border-box",
          display: "block",
          width: "100%",
          cursor: "pointer",
          textDecoration: "none",
          padding: "0.4rem 0.6rem",
          paddingLeft: `${0.6 + depth * 0.9}rem`,
          borderLeft: isSelected
            ? "3px solid var(--wp-gold, #e8b528)"
            : "3px solid transparent",
          color: isSelected ? "var(--wp-gold, #e8b528)" : "var(--wp-text, #e8eaed)",
          fontWeight: isSelected ? 700 : 500,
          fontSize: "0.9rem",
          lineHeight: 1.4,
          borderRadius: "0 6px 6px 0",
          background: isSelected ? "rgba(232,181,40,0.08)" : "transparent",
        }}
      >
        {node.title}
      </a>
      {node.children.map((child) => (
        <NavNode
          key={child.slug}
          node={child}
          depth={depth + 1}
          selectedSlug={selectedSlug}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

export default function EngineeringWiki({ pages }: EngineeringWikiProps) {
  const tree = useMemo(() => buildTree(pages), [pages]);
  const bySlug = useMemo(() => {
    const map = new Map<string, WikiPage>();
    for (const p of pages) map.set(p.slug, p);
    return map;
  }, [pages]);

  const defaultSlug = tree[0]?.slug ?? pages[0]?.slug ?? null;
  const [selectedSlug, setSelectedSlug] = useState<string | null>(defaultSlug);
  // On mobile the sidebar is collapsed by default so the content is what you
  // land on, not a full screen of nav. Selecting a page closes it.
  const [navOpen, setNavOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  // Deep-linking: the selected page is reflected in the URL (?page=<slug>) so a
  // page can be shared/bookmarked, and back/forward move between pages. Reads
  // the URL on mount and on popstate.
  useEffect(() => {
    const applyFromUrl = () => {
      const s = new URLSearchParams(window.location.search).get("page");
      if (s && bySlug.has(s)) setSelectedSlug(s);
    };
    applyFromUrl();
    window.addEventListener("popstate", applyFromUrl);
    return () => window.removeEventListener("popstate", applyFromUrl);
  }, [bySlug]);

  if (pages.length === 0) {
    return (
      <div
        data-testid="wiki-empty"
        style={{
          color: "var(--wp-text-dim, #9aa0aa)",
          padding: "2rem 0",
          fontSize: "0.95rem",
        }}
      >
        No engineering pages yet.
      </div>
    );
  }

  const activeSlug = selectedSlug && bySlug.has(selectedSlug) ? selectedSlug : defaultSlug;
  const page = activeSlug ? bySlug.get(activeSlug) ?? null : null;

  // Walk parentSlug up the map to build the breadcrumb trail (excluding self).
  const crumbs: string[] = [];
  if (page) {
    let parent = page.parentSlug ? bySlug.get(page.parentSlug) : undefined;
    const seen = new Set<string>();
    while (parent && !seen.has(parent.slug)) {
      seen.add(parent.slug);
      crumbs.unshift(parent.title);
      parent = parent.parentSlug ? bySlug.get(parent.parentSlug) : undefined;
    }
  }

  const selectPage = (slug: string) => {
    setSelectedSlug(slug);
    setNavOpen(false);
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", `?page=${encodeURIComponent(slug)}`);
    }
  };

  const copyLink = async () => {
    if (typeof window === "undefined" || !activeSlug) return;
    const url = `${window.location.origin}/engineering?page=${encodeURIComponent(activeSlug)}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard blocked (insecure context / permissions); the URL bar still
      // reflects the page, so linking works regardless.
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="wiki-layout">
      <style>{`
        .wiki-layout { display: flex; gap: 1.5rem; align-items: flex-start; }
        .wiki-nav {
          flex: 0 0 240px; min-width: 200px; display: flex; flex-direction: column;
          gap: 0.1rem; align-self: flex-start;
          border-right: 1px solid var(--wp-dark-border, rgba(255,255,255,0.1));
          padding-right: 0.5rem;
        }
        .wiki-article { flex: 1 1 auto; min-width: 0; width: 100%; }
        .wiki-nav-toggle { display: none; }
        /* Mobile: the 240px sidebar wasted space and buried the content below a
           long page list. Stack the layout, collapse the nav behind a toggle,
           and show the content first. */
        @media (max-width: 760px) {
          .wiki-layout { flex-direction: column; gap: 0.85rem; }
          .wiki-nav-toggle {
            display: flex; align-items: center; justify-content: space-between;
            width: 100%; box-sizing: border-box; cursor: pointer; gap: 0.75rem;
            background: var(--wp-dark-surface, rgba(255,255,255,0.05));
            border: 1px solid var(--wp-dark-border, rgba(255,255,255,0.14));
            border-radius: 8px; padding: 0.65rem 0.9rem; text-align: left;
            color: var(--wp-gold, #e8b528); font-weight: 700; font-size: 0.95rem;
          }
          .wiki-nav-toggle .wiki-nav-toggle-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .wiki-nav {
            flex: 1 1 auto; width: 100%; box-sizing: border-box; min-width: 0;
            border-right: none; padding-right: 0;
            border-bottom: 1px solid var(--wp-dark-border, rgba(255,255,255,0.1));
            padding-bottom: 0.5rem;
          }
          .wiki-nav[data-open="false"] { display: none; }
        }
        .wiki-md {
          color: var(--wp-text, #e8eaed);
          font-size: 0.95rem;
          line-height: 1.7;
          overflow-wrap: break-word;
          word-break: break-word;
        }
        .wiki-md h2, .wiki-md h3 {
          color: var(--wp-gold, #e8b528);
          font-weight: 700;
          line-height: 1.3;
          margin: 1.4rem 0 0.6rem;
        }
        .wiki-md h2 { font-size: 1.25rem; }
        .wiki-md h3 { font-size: 1.08rem; }
        .wiki-md h4, .wiki-md h5 {
          color: var(--wp-text, #e8eaed);
          font-weight: 700;
          margin: 1.1rem 0 0.5rem;
        }
        .wiki-md h4 { font-size: 1rem; }
        .wiki-md h5 { font-size: 0.92rem; }
        .wiki-md p { margin: 0.7rem 0; }
        /* Restore list markers: Tailwind Preflight resets list-style to none
           globally, which flattened these into a wall of text. */
        .wiki-md ul { list-style: disc outside; margin: 0.7rem 0; padding-left: 1.4rem; }
        .wiki-md ol { list-style: decimal outside; margin: 0.7rem 0; padding-left: 1.6rem; }
        .wiki-md li { margin: 0.4rem 0; padding-left: 0.25rem; line-height: 1.6; }
        .wiki-md li::marker { color: var(--wp-gold, #e8b528); font-weight: 700; }
        .wiki-md ul ul, .wiki-md ul ol, .wiki-md ol ul, .wiki-md ol ol { margin: 0.35rem 0; }
        .wiki-md a { color: var(--wp-gold, #e8b528); text-decoration: underline; }
        .wiki-md code {
          background: var(--wp-dark-surface, rgba(255,255,255,0.06));
          border: 1px solid var(--wp-dark-border, rgba(255,255,255,0.1));
          border-radius: 4px;
          padding: 0.1rem 0.35rem;
          font-size: 0.85em;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        }
        .wiki-md pre {
          background: var(--wp-dark-surface, rgba(255,255,255,0.06));
          border: 1px solid var(--wp-dark-border, rgba(255,255,255,0.1));
          border-radius: 8px;
          padding: 0.9rem 1rem;
          overflow-x: auto;
          margin: 0.8rem 0;
        }
        .wiki-md pre code {
          background: none;
          border: none;
          padding: 0;
          font-size: 0.85rem;
        }
        .wiki-md blockquote {
          border-left: 3px solid var(--wp-gold, #e8b528);
          margin: 0.8rem 0;
          padding: 0.2rem 0 0.2rem 1rem;
          color: var(--wp-text-muted, #9aa0aa);
        }
        .wiki-md table {
          border-collapse: collapse;
          margin: 0.8rem 0;
          width: 100%;
        }
        .wiki-md th, .wiki-md td {
          border: 1px solid var(--wp-dark-border, rgba(255,255,255,0.12));
          padding: 0.45rem 0.65rem;
          text-align: left;
          font-size: 0.88rem;
        }
        .wiki-md th {
          background: var(--wp-dark-surface, rgba(255,255,255,0.05));
          font-weight: 700;
        }
      `}</style>

      <button
        type="button"
        className="wiki-nav-toggle"
        data-testid="wiki-nav-toggle"
        aria-expanded={navOpen}
        aria-controls="wiki-nav"
        onClick={() => setNavOpen((o) => !o)}
      >
        <span className="wiki-nav-toggle-label">
          {navOpen ? "Hide pages" : page ? page.title : "Pages"}
        </span>
        <span aria-hidden="true">{navOpen ? "✕" : "☰"}</span>
      </button>

      <nav
        id="wiki-nav"
        aria-label="Engineering pages"
        className="wiki-nav"
        data-open={navOpen ? "true" : "false"}
      >
        {tree.map((node) => (
          <NavNode
            key={node.slug}
            node={node}
            depth={0}
            selectedSlug={activeSlug}
            onSelect={selectPage}
          />
        ))}
      </nav>

      <article className="wiki-article">
        {page ? (
          <>
            {crumbs.length > 0 ? (
              <div
                style={{
                  color: "var(--wp-text-dim, #9aa0aa)",
                  fontSize: "0.8rem",
                  marginBottom: "0.4rem",
                }}
              >
                {crumbs.join(" / ")}
              </div>
            ) : null}
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                justifyContent: "space-between",
                gap: "1rem",
                margin: "0 0 0.8rem",
                flexWrap: "wrap",
              }}
            >
              <h1
                style={{
                  margin: 0,
                  fontSize: "1.5rem",
                  fontWeight: 800,
                  color: "var(--wp-text, #e8eaed)",
                }}
              >
                {page.title}
              </h1>
              <button
                type="button"
                data-testid="wiki-copy-link"
                onClick={copyLink}
                title="Copy a link to this page"
                style={{
                  all: "unset",
                  cursor: "pointer",
                  fontSize: "0.78rem",
                  fontWeight: 700,
                  color: copied ? "var(--wp-success, #3fb950)" : "var(--wp-gold, #e8b528)",
                  border: "1px solid var(--wp-dark-border, rgba(255,255,255,0.14))",
                  borderRadius: 6,
                  padding: "0.25rem 0.6rem",
                  whiteSpace: "nowrap",
                }}
              >
                {copied ? "Link copied" : "Copy link"}
              </button>
            </div>
            {PAGE_DIAGRAMS[page.slug] ?? null}
            <div
              className="wiki-md"
              data-testid="wiki-content"
              dangerouslySetInnerHTML={{ __html: page.bodyHtml ?? "" }}
            />
          </>
        ) : null}
      </article>
    </div>
  );
}
