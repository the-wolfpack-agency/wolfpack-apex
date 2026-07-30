/**
 * engineering-tree.ts: the client-safe half of the Engineering wiki domain.
 *
 * Holds the wiki page types plus the pure `buildTree` helper, with NO database
 * import, so client components (EngineeringWiki, the /engineering page) can use
 * them without dragging `pg` (and Node builtins: dns/fs/net/tls) into the
 * browser bundle. The server half (queries) lives in `engineering.ts`, which
 * re-exports these so server callers keep a single import surface.
 */

export interface WikiPage {
  id: string;
  slug: string;
  parentSlug: string | null;
  title: string;
  /** Markdown. */
  body: string;
  /** Server-rendered, sanitized HTML of `body`. Populated by the API layer, not
   *  the DB read, so client consumers render without importing the sanitizer. */
  bodyHtml?: string;
  position: number;
  published: boolean;
  createdBy: string | null;
  updatedAt: string;
}

/** A page plus its descendants, for the sidebar tree. */
export interface WikiPageNode extends WikiPage {
  children: WikiPageNode[];
}

/** Build the sidebar tree from a flat page list. Orphans (missing parent) surface
 *  at the top level so nothing is ever hidden by a bad parent_slug. */
export function buildTree(pages: WikiPage[]): WikiPageNode[] {
  const bySlug = new Map<string, WikiPageNode>();
  for (const p of pages) bySlug.set(p.slug, { ...p, children: [] });
  const roots: WikiPageNode[] = [];
  for (const node of bySlug.values()) {
    const parent = node.parentSlug ? bySlug.get(node.parentSlug) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (ns: WikiPageNode[]) => {
    ns.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
    ns.forEach((n) => sort(n.children));
  };
  sort(roots);
  return roots;
}
