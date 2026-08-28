/**
 * Where data enters a system, and where it leaves.
 *
 * WHY AN ENGAGEMENT NEEDS THIS FIRST. A finding list says what is broken. A
 * data-flow map says what the system IS: every form is a place information
 * arrives, and every third-party origin is a place it departs. An engineer
 * handed the keys draws this map before proposing anything, because a
 * recommendation made without knowing where the data goes is a guess.
 *
 * It is also the part a client most often cannot produce themselves. Nobody
 * has a current list of every form on their estate or every vendor their pages
 * contact, and the second one is what a privacy review asks for.
 *
 * PURE STRING WORK, NO BROWSER, NO DEPENDENCY. collectPageFacts next door
 * needs a real page because it asks about consent banners and runtime globals.
 * This asks what the markup declares, which is answerable from the HTML the
 * crawler already fetches, and the docx and pptx extractors in this codebase
 * proved regex over markup beats adding a parser.
 *
 * PRECISION-FIRST, matching the scanner philosophy. It reports what the page
 * states outright and does not guess: a form built by JavaScript after load is
 * not here, and saying so in the caveat is better than inferring one.
 */

/** A place information arrives. */
export interface EntryPoint {
  /** Page the form appears on. */
  page: string;
  /** Where it submits to, resolved. Empty means it posts to itself. */
  action: string;
  method: string;
  /** True when the form submits to an origin other than the site's own. */
  crossOrigin: boolean;
  /**
   * Field kinds worth a second look: passwords, uploads, payment-shaped names.
   * Named, never valued, because a scan that records what a field is called is
   * useful and one that records what somebody typed is a breach.
   */
  sensitiveFields: string[];
}

/** A place information departs. */
export interface ExitPoint {
  /** Origin contacted, e.g. https://analytics.example.net. */
  origin: string;
  /** How the page reaches it: a script, an image, a frame, a form. */
  via: string[];
  /** Pages that contact it. */
  pages: string[];
}

export interface DataFlowMap {
  entryPoints: EntryPoint[];
  exitPoints: ExitPoint[];
  /** Pages actually read, so coverage can be judged rather than assumed. */
  pagesRead: number;
}

/* Field names worth flagging. Deliberately short: a long list of guesses
   produces noise, and noise in a client report costs more than a miss. */
const SENSITIVE_TOKENS = new Set([
  "password", "pass", "passwd", "pwd",
  "ssn", "social",
  "card", "cvv", "cvc", "iban", "routing",
  "dob", "birthdate", "birthday",
]);
const SENSITIVE_TYPE = /^(password|file)$/i;

/**
 * Split a field name into words, then match whole words only.
 *
 * WRITTEN FIRST AS A REGEX WITH WORD BOUNDARIES, which silently missed the
 * commonest real name of all. In `card_number` the underscore IS a word
 * character, so `\bcard\b` never matches, and every snake_case payment field
 * went unflagged.
 *
 * Dropping the boundary is worse: `discard` contains `card`, and a report that
 * flags a discard button as a payment field is a report nobody trusts twice.
 *
 * Tokenising handles both, and camelCase with it: card_number, card-number and
 * cardNumber all split to ["card", "number"], while discard stays one word.
 */
function isSensitiveName(name: string): boolean {
  const tokens = name
    /* camelCase to spaced, before splitting on separators. */
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return tokens.some((t) => SENSITIVE_TOKENS.has(t));
}

const FORM_RE = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
const INPUT_RE = /<(?:input|select|textarea)\b([^>]*)>/gi;
const ATTR = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag);
  return m ? m[1] : null;
};

/** Elements that fetch something from somewhere. */
const RESOURCE_RE =
  /<(script|img|iframe|link|source|video|audio)\b([^>]*)>/gi;
const RESOURCE_ATTR: Record<string, string> = {
  script: "src",
  img: "src",
  iframe: "src",
  link: "href",
  source: "src",
  video: "src",
  audio: "src",
};

function originOf(raw: string, pageUrl: string): string | null {
  try {
    const u = new URL(raw, pageUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Read one page's markup.
 *
 * Exported so the shape can be tested without a server, which is how the other
 * extractors in this codebase are tested too.
 */
export function extractDataFlows(
  html: string,
  pageUrl: string,
): { entryPoints: EntryPoint[]; exitOrigins: Array<{ origin: string; via: string }> } {
  const siteOrigin = originOf(pageUrl, pageUrl);
  const entryPoints: EntryPoint[] = [];
  const exitOrigins: Array<{ origin: string; via: string }> = [];

  FORM_RE.lastIndex = 0;
  let form: RegExpExecArray | null;
  while ((form = FORM_RE.exec(html)) !== null) {
    const attrs = form[1] ?? "";
    const inner = form[2] ?? "";
    const rawAction = ATTR(attrs, "action") ?? "";
    const actionOrigin = rawAction ? originOf(rawAction, pageUrl) : siteOrigin;

    const sensitiveFields: string[] = [];
    INPUT_RE.lastIndex = 0;
    let field: RegExpExecArray | null;
    while ((field = INPUT_RE.exec(inner)) !== null) {
      const fieldAttrs = field[1] ?? "";
      const name = ATTR(fieldAttrs, "name") ?? ATTR(fieldAttrs, "id") ?? "";
      const type = ATTR(fieldAttrs, "type") ?? "";
      if (SENSITIVE_TYPE.test(type) || isSensitiveName(name)) {
        /* The NAME, never a value. A scan recording what somebody typed is a
           breach rather than a report. */
        const label = (name || type).slice(0, 60);
        if (label && !sensitiveFields.includes(label)) sensitiveFields.push(label);
      }
    }

    const crossOrigin = !!actionOrigin && !!siteOrigin && actionOrigin !== siteOrigin;
    entryPoints.push({
      page: pageUrl,
      action: rawAction,
      method: (ATTR(attrs, "method") ?? "GET").toUpperCase(),
      crossOrigin,
      sensitiveFields,
    });

    /* A form posting off-site is an exit point as well as an entry one, and
       the most consequential kind: it is the page handing typed input to
       somebody else. */
    if (crossOrigin && actionOrigin) {
      exitOrigins.push({ origin: actionOrigin, via: "form" });
    }
  }

  RESOURCE_RE.lastIndex = 0;
  let res: RegExpExecArray | null;
  while ((res = RESOURCE_RE.exec(html)) !== null) {
    const tag = (res[1] ?? "").toLowerCase();
    const attrs = res[2] ?? "";
    const raw = ATTR(attrs, RESOURCE_ATTR[tag] ?? "src");
    if (!raw) continue;
    const origin = originOf(raw, pageUrl);
    if (!origin || origin === siteOrigin) continue;
    exitOrigins.push({ origin, via: tag });
  }

  return { entryPoints, exitOrigins };
}

export interface MapDataFlowsDeps {
  fetchImpl?: typeof fetch;
}

/** Bounded: a map, not a mirror of the site. */
const MAX_PAGES = 12;
const PAGE_TIMEOUT_MS = 8_000;
const MAX_HTML_CHARS = 500_000;

/**
 * Read a bounded sample of pages and merge what they declare.
 *
 * A sample rather than everything, because the point is to learn the SHAPE of
 * the data flows. The twelfth page rarely introduces a vendor the first eleven
 * did not, and a scan is a guest on somebody's production system.
 */
export async function mapDataFlows(
  baseUrl: string,
  paths: readonly string[],
  deps: MapDataFlowsDeps = {},
): Promise<DataFlowMap> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const entryPoints: EntryPoint[] = [];
  const byOrigin = new Map<string, { via: Set<string>; pages: Set<string> }>();
  let pagesRead = 0;

  for (const path of paths.slice(0, MAX_PAGES)) {
    const pageUrl = new URL(path, baseUrl).toString();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
    try {
      const res = await fetchImpl(pageUrl, { signal: controller.signal });
      const type = res.headers?.get?.("content-type") ?? "";
      /* Only markup. Fetching a PDF and regexing it for <form> wastes a
         request and finds nothing. */
      if (!/text\/html/i.test(type)) continue;

      const html = (await res.text()).slice(0, MAX_HTML_CHARS);
      pagesRead += 1;

      const found = extractDataFlows(html, pageUrl);
      entryPoints.push(...found.entryPoints);
      for (const { origin, via } of found.exitOrigins) {
        const seen = byOrigin.get(origin) ?? { via: new Set(), pages: new Set() };
        seen.via.add(via);
        seen.pages.add(pageUrl);
        byOrigin.set(origin, seen);
      }
    } catch {
      /* One unreadable page must not cost the map. */
    } finally {
      clearTimeout(timer);
    }
  }

  const exitPoints: ExitPoint[] = [...byOrigin.entries()]
    .map(([origin, v]) => ({
      origin,
      via: [...v.via].sort(),
      pages: [...v.pages],
    }))
    /* Most-contacted first: the vendor on every page matters more than the one
       on a single archived article. */
    .sort((a, b) => b.pages.length - a.pages.length);

  return { entryPoints, exitPoints, pagesRead };
}
