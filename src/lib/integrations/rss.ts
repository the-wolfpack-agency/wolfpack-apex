/**
 * Reading an RSS feed, without a dependency.
 *
 * WHY THIS FILE EXISTS
 *
 * `headlines` had a private parser for the one BBC feed it reads. The news
 * search added alongside it reads several feeds from different publishers, and
 * copying the parser would have been the second copy of the only fiddly part of
 * either tool: CDATA unwrapping and entity decoding, where the ORDER of the
 * replacements is load-bearing. Two copies drift, and the one that drifts is
 * the one nobody is looking at.
 *
 * NO XML LIBRARY, deliberately. CLAUDE.md forbids new runtime dependencies
 * without justification, and the justification is thin: RSS <item> blocks are a
 * stable shape, and a full parser would be the largest thing in the bundle to
 * read four fields.
 *
 * NOT A GENERAL XML PARSER, and it should never become one. It reads item
 * blocks out of a feed. It does not resolve entities beyond the handful below,
 * follow namespaces, or validate anything.
 */

/** One entry from a feed, normalized across publishers. */
export interface FeedItem {
  title: string;
  link: string;
  /** The publisher's own date string, verbatim. Empty when absent. */
  published: string;
  /** A short summary when the feed carries one. Empty when it does not. */
  summary: string;
  /** Which feed this came from, for attribution. */
  source: string;
}

/**
 * Pull one tag's text out of a block.
 *
 * Exported for its own test: the entity ordering below is the kind of thing
 * that looks obviously right and is obviously wrong once.
 */
export function extractTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(block);
  if (!m) return "";
  let raw = m[1].trim();
  /* Unwrap <![CDATA[ … ]]>. */
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
  if (cdata) raw = cdata[1].trim();
  /* `&amp;` MUST be decoded LAST: decoding it first would turn the literal
     text `&amp;lt;` into `<` (double-unescaping) instead of `&lt;`. */
  return raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Strip tags out of a summary. Feed descriptions often carry markup. */
function textOnly(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/\s{2,}/g, " ").trim();
}

/**
 * Every item in a feed, oldest-to-newest order preserved as published.
 *
 * `limit` bounds the work per feed; a publisher that returns two hundred items
 * should not cost two hundred items of parsing on every call.
 */
export function parseFeed(xml: string, source: string, limit = 40): FeedItem[] {
  const items: FeedItem[] = [];
  /* <item> is RSS; <entry> is Atom. Both appear across publishers. */
  const blocks = xml.match(/<(?:item|entry)[\s>][\s\S]*?<\/(?:item|entry)>/gi) ?? [];
  for (const block of blocks) {
    const title = extractTag(block, "title");
    /* Atom puts the URL in an attribute rather than in the element body. */
    const link =
      extractTag(block, "link") || /<link[^>]*href="([^"]+)"/i.exec(block)?.[1] || "";
    if (!title || !link) continue;
    items.push({
      title,
      link,
      published: extractTag(block, "pubDate") || extractTag(block, "published") || extractTag(block, "updated"),
      summary: textOnly(extractTag(block, "description") || extractTag(block, "summary")).slice(0, 300),
      source,
    });
    if (items.length >= limit) break;
  }
  return items;
}

/**
 * GET a feed, giving up after `timeoutMs`.
 *
 * NEVER THROWS, and NULL IS NOT AN EMPTY LIST. `null` means the feed could not
 * be read at all; `[]` means it was read and had nothing. Collapsing the two
 * into `[]` is tempting and wrong in both directions: a search across several
 * publishers would report "nothing published" when in fact it could not look,
 * and a single-feed caller would report success on a network failure. That
 * second one is not hypothetical, it broke two headlines tests the moment the
 * parser was shared.
 */
export async function fetchFeed(
  url: string,
  source: string,
  timeoutMs: number,
  limit?: number,
): Promise<FeedItem[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return parseFeed(await res.text(), source, limit);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
