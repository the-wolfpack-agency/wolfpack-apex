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

import { useMemo, useState } from "react";
import type { WikiPage, WikiPageNode } from "@/lib/engineering-tree";
import { buildTree } from "@/lib/engineering-tree";

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
      <button
        type="button"
        data-testid={`wiki-nav-${node.slug}`}
        onClick={() => onSelect(node.slug)}
        aria-current={isSelected ? "page" : undefined}
        style={{
          all: "unset",
          boxSizing: "border-box",
          display: "block",
          width: "100%",
          cursor: "pointer",
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
      </button>
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

  return (
    <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
      <style>{`
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
        .wiki-md p { margin: 0.6rem 0; }
        .wiki-md ul, .wiki-md ol { margin: 0.6rem 0; padding-left: 1.5rem; }
        .wiki-md li { margin: 0.25rem 0; }
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

      <nav
        aria-label="Engineering pages"
        style={{
          flex: "0 0 240px",
          minWidth: 200,
          display: "flex",
          flexDirection: "column",
          gap: "0.1rem",
          alignSelf: "flex-start",
          borderRight: "1px solid var(--wp-dark-border, rgba(255,255,255,0.1))",
          paddingRight: "0.5rem",
        }}
      >
        {tree.map((node) => (
          <NavNode
            key={node.slug}
            node={node}
            depth={0}
            selectedSlug={activeSlug}
            onSelect={setSelectedSlug}
          />
        ))}
      </nav>

      <article style={{ flex: "1 1 320px", minWidth: 0 }}>
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
            <h1
              style={{
                margin: "0 0 0.8rem",
                fontSize: "1.5rem",
                fontWeight: 800,
                color: "var(--wp-text, #e8eaed)",
              }}
            >
              {page.title}
            </h1>
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
