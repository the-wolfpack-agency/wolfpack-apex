/**
 * figma-import — "seed a site from a Figma file" pipeline.
 *
 * Designer pastes a Figma file URL (either `figma.com/file/:key/...` or
 * `figma.com/design/:key/...`). We call Figma's REST API with the
 * server-side `FIGMA_ACCESS_TOKEN` to pull the file tree — typed nodes
 * with fills, fonts, sizes — and produce a structured SiteBrief
 * suggestion: palette, primary font, and frame-to-section mapping.
 *
 * This is the high-fidelity counterpart to `brand-url-import.ts`. The
 * brand scraper reads public HTML; Figma gives us the designer's actual
 * layers. Two separate sources, one end-state: a seeded SiteBrief.
 *
 * Security posture (token-first):
 *   - The Figma access token is a server-only env var. Never logged,
 *     never echoed to the client, never placed in analytics metadata.
 *   - Host lock: only the `api.figma.com` / `www.figma.com` /
 *     `figma.com` hosts are accepted in the input URL. No arbitrary
 *     hosts can sneak through — the URL parser rejects anything else.
 *   - 15s hard timeout via AbortController. Figma files can be large;
 *     we still cap to keep the Vercel function budget sane.
 *   - User-Agent identifies Instinct so Figma can block/allow at will.
 *   - 401 / 404 / 429 map cleanly to typed reasons; the access token
 *     never leaks into any response body or error message.
 *
 * Analytics posture (learning-loop):
 *   - figma_import_requested  — fires on every attempt, file_key only
 *     (no URL → no query-string PII).
 *   - figma_import_completed  — fires on ok path with size signals
 *     (frame/color/font counts + latency).
 *   - figma_import_failed     — typed reason per failure path.
 *   - figma_import_applied    — fires from the UI on "Apply". KPI:
 *     acceptance rate of the Figma-derived suggestion.
 *
 * Zero-token invariant: no LLM calls. Figma's API is deterministic
 * REST; the transformation from API response to SiteBrief suggestion
 * is a pure function. This is the global "build patterns into tooling,
 * then run tooling" rule in action.
 */

import { trackEvent } from "./analytics";

/* --------------------------------------------------------------------- *
 * Public types
 * --------------------------------------------------------------------- */

export interface FigmaImportInput {
  /** A Figma file URL: /file/:key/... or /design/:key/... */
  url: string;
}

export type FigmaImportReason =
  | "ok"
  | "invalid_url"
  | "not_configured"
  | "unauthorized"
  | "file_not_found"
  | "rate_limited"
  | "timeout"
  | "fetch_failed"
  | "empty_result";

export interface FigmaScrapedNode {
  id: string;
  /** Layer name — often semantic ("Hero", "Pricing Card"). */
  name: string;
  /** RECTANGLE | TEXT | FRAME | COMPONENT | etc. */
  type: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fills?: Array<{
    type: string;
    color?: { r: number; g: number; b: number; a: number };
  }>;
  /** TEXT node content. */
  characters?: string;
  fontName?: { family?: string; style?: string };
  fontSize?: number;
  children?: FigmaScrapedNode[];
}

export interface FigmaImportScrapedResult {
  fileKey: string;
  fileName: string;
  lastModified: string;
  topLevelFrames: FigmaScrapedNode[];
  /** Unique hex values extracted from fills, sorted by frequency desc. */
  colors: string[];
  /** Families found, each with the set of weights seen. */
  fonts: Array<{ family: string; weights: number[] }>;
  /** One entry per top-level frame, mapped to a brief Page suggestion. */
  suggestedBriefPages: Array<{
    route: string;
    title: string;
    frameId: string;
    sectionHints: Array<{ type: string; heading?: string; body?: string }>;
  }>;
  latencyMs: number;
}

export interface FigmaBriefSuggestion {
  theme?: {
    colors?: { primary?: string; accent?: string; bg?: string; fg?: string };
    font?: { family?: string };
  };
  pages?: Array<{ route: string; title?: string; sections: unknown[] }>;
}

export interface FigmaImportResult {
  ok: boolean;
  reason: FigmaImportReason;
  scraped: FigmaImportScrapedResult | null;
  briefSuggestion: FigmaBriefSuggestion | null;
  /** Optional Retry-After seconds surfaced from Figma on 429. */
  retryAfterSeconds?: number;
}

export interface FigmaImportDeps {
  /** Injectable fetch for tests. Never hits the network in unit tests. */
  fetchImpl?: typeof fetch;
  /** Injectable clock so latency is deterministic in tests. */
  now?: () => number;
  /** User id + role for analytics attribution. */
  user?: { id: string; role: string };
  /** Override the access token (tests); defaults to process.env. */
  accessToken?: string;
}

/* --------------------------------------------------------------------- *
 * Constants — single source of truth; exported for tests.
 * --------------------------------------------------------------------- */

export const FIGMA_TIMEOUT_MS = 15_000;
export const FIGMA_USER_AGENT =
  "Instinct-FigmaImporter/1.0 (+https://wolfpack-instinct.vercel.app/about)";
/** Figma REST base. Overridable via dependency injection in tests. */
export const FIGMA_API_BASE = "https://api.figma.com";

/**
 * Frame-name → SectionType heuristics. Figma layer names are designer-
 * authored and drift; we map the most common patterns so the
 * SiteBrief suggestion reads as section types from day one. Anything
 * unmatched falls through to `content` — the most forgiving section.
 *
 * Keep this list small + explicit. A noisy heuristic produces wrong
 * section types that the designer then has to unpick, which is worse
 * than an over-generic default.
 */
const FRAME_NAME_HEURISTICS: Array<{ pattern: RegExp; type: string }> = [
  { pattern: /hero|banner|masthead|cover|splash/i, type: "hero" },
  { pattern: /feature|card grid|services|offerings/i, type: "cards" },
  { pattern: /testimonial|quote|review/i, type: "testimonial" },
  { pattern: /pricing|plan|tier/i, type: "pricing" },
  { pattern: /faq|question/i, type: "faq" },
  { pattern: /stat|metric|number/i, type: "stats" },
  { pattern: /cta|call to action/i, type: "cta" },
  { pattern: /video|embed/i, type: "video" },
  { pattern: /gallery|images|photo/i, type: "gallery" },
  { pattern: /footer/i, type: "footer" },
  { pattern: /contact|form/i, type: "contact" },
];

/* --------------------------------------------------------------------- *
 * URL parsing
 * --------------------------------------------------------------------- */

/**
 * Parse a Figma URL into { fileKey, nodeId? }.
 *
 * Accepts:
 *   https://www.figma.com/file/ABC123/slug
 *   https://www.figma.com/design/ABC123/slug
 *   https://figma.com/file/ABC123/slug
 *   https://www.figma.com/file/ABC123/slug?node-id=12%3A34
 *
 * Rejects: non-figma.com hosts, file-url schemes, empty input, URLs
 * without a file key segment.
 */
export function parseFigmaUrl(
  url: string,
): { fileKey: string; nodeId?: string } | null {
  const trimmed = (url ?? "").trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const okHost =
    host === "figma.com" ||
    host === "www.figma.com" ||
    host.endsWith(".figma.com");
  if (!okHost) return null;
  // Path looks like /file/:key/slug OR /design/:key/slug.
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const kind = parts[0].toLowerCase();
  if (kind !== "file" && kind !== "design") return null;
  const fileKey = parts[1];
  // File keys are alphanumeric. Guard so a bad URL ("/file/%2f...") can't
  // squeeze a crafted path into the upstream fetch.
  if (!/^[A-Za-z0-9]+$/.test(fileKey)) return null;
  const nodeParam = u.searchParams.get("node-id") ?? undefined;
  return nodeParam ? { fileKey, nodeId: nodeParam } : { fileKey };
}

/* --------------------------------------------------------------------- *
 * Figma API response shapes (typed locally — we only read what we need)
 * --------------------------------------------------------------------- */

interface FigmaPaint {
  type?: string;
  visible?: boolean;
  color?: { r: number; g: number; b: number };
  opacity?: number;
}

interface FigmaTypeStyle {
  fontFamily?: string;
  fontPostScriptName?: string;
  fontWeight?: number;
  fontSize?: number;
  italic?: boolean;
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  fills?: FigmaPaint[];
  characters?: string;
  style?: FigmaTypeStyle;
  absoluteBoundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

interface FigmaFileResponse {
  name: string;
  lastModified: string;
  document: FigmaNode;
}

/* --------------------------------------------------------------------- *
 * Paint → hex + alpha helpers
 * --------------------------------------------------------------------- */

function channel(x: number): string {
  const n = Math.max(0, Math.min(255, Math.round(x * 255)));
  return n.toString(16).padStart(2, "0");
}

export function paintToHex(paint: FigmaPaint | null | undefined): string | null {
  if (!paint || paint.visible === false) return null;
  if (paint.type !== "SOLID" || !paint.color) return null;
  const { r, g, b } = paint.color;
  if (
    typeof r !== "number" ||
    typeof g !== "number" ||
    typeof b !== "number"
  ) {
    return null;
  }
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/* --------------------------------------------------------------------- *
 * Node tree helpers — traversal, coercion to the public type
 * --------------------------------------------------------------------- */

function coerceNode(n: FigmaNode, depth = 0): FigmaScrapedNode {
  const box = n.absoluteBoundingBox;
  const out: FigmaScrapedNode = {
    id: n.id,
    name: n.name,
    type: n.type,
  };
  if (box) {
    out.x = box.x;
    out.y = box.y;
    out.width = box.width;
    out.height = box.height;
  }
  if (Array.isArray(n.fills) && n.fills.length > 0) {
    out.fills = n.fills
      .filter((f) => f && f.visible !== false)
      .map((f) => ({
        type: f.type ?? "UNKNOWN",
        ...(f.color
          ? {
              color: {
                r: f.color.r,
                g: f.color.g,
                b: f.color.b,
                a: typeof f.opacity === "number" ? f.opacity : 1,
              },
            }
          : {}),
      }));
  }
  if (typeof n.characters === "string") {
    out.characters = n.characters;
  }
  if (n.style) {
    if (n.style.fontFamily || n.style.fontPostScriptName) {
      out.fontName = {
        family: n.style.fontFamily,
        style: n.style.fontPostScriptName,
      };
    }
    if (typeof n.style.fontSize === "number") {
      out.fontSize = n.style.fontSize;
    }
  }
  // Cap recursion so a pathological Figma file doesn't explode memory.
  // 12 is deep enough for any real component tree.
  if (depth < 12 && Array.isArray(n.children) && n.children.length > 0) {
    out.children = n.children.map((c) => coerceNode(c, depth + 1));
  }
  return out;
}

function walk(
  node: FigmaScrapedNode,
  visit: (n: FigmaScrapedNode) => void,
): void {
  visit(node);
  if (node.children) {
    for (const c of node.children) walk(c, visit);
  }
}

/* --------------------------------------------------------------------- *
 * Aggregators — colors by frequency, fonts by family+weight
 * --------------------------------------------------------------------- */

function collectColors(frames: FigmaScrapedNode[]): string[] {
  const freq = new Map<string, number>();
  for (const root of frames) {
    walk(root, (n) => {
      if (!n.fills) return;
      for (const f of n.fills) {
        if (f.type !== "SOLID" || !f.color) continue;
        const hex = paintToHex({
          type: f.type,
          color: { r: f.color.r, g: f.color.g, b: f.color.b },
          opacity: f.color.a,
        });
        if (!hex) continue;
        freq.set(hex, (freq.get(hex) ?? 0) + 1);
      }
    });
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hex]) => hex);
}

function collectFonts(
  frames: FigmaScrapedNode[],
): Array<{ family: string; weights: number[] }> {
  const families = new Map<string, Set<number>>();
  for (const root of frames) {
    walk(root, (n) => {
      const fam = n.fontName?.family;
      if (!fam) return;
      const size = typeof n.fontSize === "number" ? n.fontSize : 400;
      // Figma surfaces weights via style name; postScript + family are the
      // canonical carriers but we don't rely on their parsing here. We use
      // fontSize as a weight proxy ONLY if nothing else; real weight
      // detection would require reading the `style` block which is often
      // a textual "Bold" / "Regular". We collect the style string into a
      // weight bucket when we can parse it.
      const styleTxt = n.fontName?.style?.toLowerCase() ?? "";
      const weight = parseWeightFromStyle(styleTxt) ?? Math.round(size);
      if (!families.has(fam)) families.set(fam, new Set());
      families.get(fam)!.add(weight);
    });
  }
  const out: Array<{ family: string; weights: number[] }> = [];
  for (const [fam, weights] of families) {
    out.push({
      family: fam,
      weights: [...weights].sort((a, b) => a - b),
    });
  }
  return out;
}

function parseWeightFromStyle(style: string): number | null {
  if (!style) return null;
  if (/thin/.test(style)) return 100;
  if (/extralight|extra[ -]?light/.test(style)) return 200;
  if (/light/.test(style)) return 300;
  if (/regular|normal|book/.test(style)) return 400;
  if (/medium/.test(style)) return 500;
  if (/semibold|semi[ -]?bold|demibold/.test(style)) return 600;
  if (/extrabold|extra[ -]?bold|heavy/.test(style)) return 800;
  if (/bold/.test(style)) return 700;
  if (/black/.test(style)) return 900;
  return null;
}

/* --------------------------------------------------------------------- *
 * Section hint heuristics — frame name → SectionType
 * --------------------------------------------------------------------- */

function guessSectionType(name: string): string {
  for (const h of FRAME_NAME_HEURISTICS) {
    if (h.pattern.test(name)) return h.type;
  }
  return "content";
}

/**
 * Walk a top-level frame's direct children; each child frame/group
 * becomes a section hint. TEXT nodes inside it become heading/body
 * candidates for the section.
 */
function frameToSectionHints(
  frame: FigmaScrapedNode,
): Array<{ type: string; heading?: string; body?: string }> {
  // Prefer direct children that look like section blocks (FRAME | GROUP |
  // COMPONENT | INSTANCE). If the designer flattened the design, fall
  // back to a single section derived from the frame itself.
  const subSections = (frame.children ?? []).filter((c) =>
    ["FRAME", "GROUP", "COMPONENT", "INSTANCE", "COMPONENT_SET"].includes(
      c.type,
    ),
  );
  if (subSections.length === 0) {
    return [
      {
        type: guessSectionType(frame.name),
        heading: findFirstText(frame),
      },
    ];
  }
  return subSections.map((s) => {
    const heading = findFirstText(s);
    const body = findBodyText(s, heading);
    return {
      type: guessSectionType(s.name),
      ...(heading ? { heading } : {}),
      ...(body ? { body } : {}),
    };
  });
}

function findFirstText(node: FigmaScrapedNode): string | undefined {
  let found: string | undefined;
  walk(node, (n) => {
    if (found) return;
    if (n.type === "TEXT" && n.characters && n.characters.trim()) {
      found = n.characters.trim();
    }
  });
  return found;
}

function findBodyText(
  node: FigmaScrapedNode,
  excludeHeading: string | undefined,
): string | undefined {
  const texts: string[] = [];
  walk(node, (n) => {
    if (n.type !== "TEXT") return;
    if (!n.characters) return;
    const t = n.characters.trim();
    if (!t) return;
    if (excludeHeading && t === excludeHeading) return;
    texts.push(t);
  });
  // Join the top 3 non-heading texts — longer than a few sentences gets
  // collapsed so the suggestion stays readable in the UI.
  return texts.slice(0, 3).join(" ").slice(0, 400) || undefined;
}

/* --------------------------------------------------------------------- *
 * BRIEF SUGGESTION — pure: scraped nodes → { theme, pages }
 * --------------------------------------------------------------------- */

/**
 * `nodesToBriefSuggestion` — the pure heart of the importer.
 *
 * Given a list of top-level frames (already coerced to FigmaScrapedNode),
 * produce a { theme, pages } suggestion ready to merge into a SiteBrief.
 *
 * Returns null when the input contains nothing useful (no frames, no
 * colors, no fonts). Callers can treat null as "empty_result".
 */
export function nodesToBriefSuggestion(
  nodes: FigmaScrapedNode[],
): FigmaImportResult["briefSuggestion"] {
  if (!Array.isArray(nodes) || nodes.length === 0) return null;
  const colors = collectColors(nodes);
  const fonts = collectFonts(nodes);
  const theme: FigmaBriefSuggestion["theme"] = {};
  if (colors.length > 0) {
    const byCount = colors; // already sorted desc
    const palette: NonNullable<FigmaBriefSuggestion["theme"]>["colors"] = {};
    if (byCount[0]) palette.primary = byCount[0];
    if (byCount[1] && byCount[1] !== byCount[0]) palette.accent = byCount[1];
    if (byCount[2]) palette.bg = byCount[2];
    if (byCount[3]) palette.fg = byCount[3];
    theme.colors = palette;
  }
  if (fonts.length > 0) {
    theme.font = { family: fonts[0].family };
  }
  // One Page per top-level frame. Skip frames whose name starts with `_`
  // or `.` (common Figma convention for hidden/working frames).
  const pages: NonNullable<FigmaBriefSuggestion["pages"]> = [];
  for (const frame of nodes) {
    if (!frame.name || frame.name.startsWith("_") || frame.name.startsWith(".")) {
      continue;
    }
    const hints = frameToSectionHints(frame);
    const route = frameNameToRoute(frame.name);
    pages.push({
      route,
      title: frame.name,
      // Each sectionHint becomes a BriefSection-shaped object. We keep
      // the type `unknown[]` in the return signature so the caller owns
      // any per-section-type validation they need.
      sections: hints.map((h) => ({
        type: h.type,
        ...(h.heading ? { heading: h.heading } : {}),
        ...(h.body ? { body: h.body } : {}),
      })),
    });
  }
  if (
    Object.keys(theme).length === 0 &&
    pages.length === 0
  ) {
    return null;
  }
  const suggestion: FigmaBriefSuggestion = {};
  if (Object.keys(theme).length > 0) suggestion.theme = theme;
  if (pages.length > 0) suggestion.pages = pages;
  return suggestion;
}

/**
 * Convert a Figma frame name to a URL route. "Home" → "/", "About us"
 * → "/about-us". We lowercase + slugify + prefix with "/". The first
 * frame we process lands on "/" regardless of name so every site has
 * a home route.
 */
function frameNameToRoute(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug || slug === "home" || slug === "index" || slug === "landing") {
    return "/";
  }
  return `/${slug}`;
}

/* --------------------------------------------------------------------- *
 * HTTP — Figma REST call
 * --------------------------------------------------------------------- */

async function callFigma<T>(
  path: string,
  token: string,
  deps: FigmaImportDeps,
): Promise<
  | { ok: true; data: T; status: number }
  | {
      ok: false;
      reason: "unauthorized" | "file_not_found" | "rate_limited" | "timeout" | "fetch_failed";
      retryAfterSeconds?: number;
    }
> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIGMA_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${FIGMA_API_BASE}${path}`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        // NEVER log the token. This header is set, never echoed anywhere.
        "X-Figma-Token": token,
        "User-Agent": FIGMA_USER_AGENT,
        Accept: "application/json",
      },
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "unauthorized" };
    }
    if (res.status === 404) {
      return { ok: false, reason: "file_not_found" };
    }
    if (res.status === 429) {
      const retry = res.headers.get("retry-after");
      const n = retry ? Number(retry) : NaN;
      return {
        ok: false,
        reason: "rate_limited",
        retryAfterSeconds: Number.isFinite(n) ? n : undefined,
      };
    }
    if (!res.ok) {
      return { ok: false, reason: "fetch_failed" };
    }
    let data: T;
    try {
      data = (await res.json()) as T;
    } catch {
      return { ok: false, reason: "fetch_failed" };
    }
    return { ok: true, data, status: res.status };
  } catch (err) {
    const name = (err as Error)?.name ?? "";
    if (name === "AbortError") return { ok: false, reason: "timeout" };
    return { ok: false, reason: "fetch_failed" };
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------------------------- *
 * Entry point — importFromFigmaUrl
 * --------------------------------------------------------------------- */

export async function importFromFigmaUrl(
  input: FigmaImportInput,
  deps: FigmaImportDeps = {},
): Promise<FigmaImportResult> {
  const now = deps.now ?? (() => Date.now());
  const started = now();
  const userId = deps.user?.id ?? "";
  const userRole = deps.user?.role ?? "";

  const parsed = parseFigmaUrl(input.url);
  if (!parsed) {
    // No file_key yet, so analytics for the invalid case omits it.
    if (userId) {
      trackEvent("figma_import_requested", userId, userRole, {
        file_key: "",
      });
      trackEvent("figma_import_failed", userId, userRole, {
        file_key: "",
        reason: "invalid_url",
      });
    }
    return empty("invalid_url");
  }
  const fileKey = parsed.fileKey;

  const token = deps.accessToken ?? process.env.FIGMA_ACCESS_TOKEN ?? "";
  if (!token) {
    if (userId) {
      trackEvent("figma_import_requested", userId, userRole, {
        file_key: fileKey,
      });
      trackEvent("figma_import_failed", userId, userRole, {
        file_key: fileKey,
        reason: "not_configured",
      });
    }
    return empty("not_configured");
  }

  if (userId) {
    trackEvent("figma_import_requested", userId, userRole, {
      file_key: fileKey,
    });
  }

  const api = await callFigma<FigmaFileResponse>(
    `/v1/files/${encodeURIComponent(fileKey)}`,
    token,
    deps,
  );
  if (!api.ok) {
    if (userId) {
      trackEvent("figma_import_failed", userId, userRole, {
        file_key: fileKey,
        reason: api.reason,
      });
    }
    const result = empty(api.reason);
    if ("retryAfterSeconds" in api && api.retryAfterSeconds !== undefined) {
      result.retryAfterSeconds = api.retryAfterSeconds;
    }
    return result;
  }

  const file = api.data;
  // Top-level frames live as direct children of the top-level PAGE
  // nodes (which are direct children of document). We flatten once.
  const pageNodes = (file.document?.children ?? []) as FigmaNode[];
  const rawTopFrames: FigmaNode[] = [];
  for (const p of pageNodes) {
    if (!p || !Array.isArray(p.children)) continue;
    for (const c of p.children) {
      if (!c) continue;
      if (c.type === "FRAME" || c.type === "COMPONENT" || c.type === "COMPONENT_SET") {
        rawTopFrames.push(c);
      }
    }
  }
  const topLevelFrames = rawTopFrames.map((n) => coerceNode(n));
  const colors = collectColors(topLevelFrames);
  const fonts = collectFonts(topLevelFrames);

  const suggestedBriefPages = topLevelFrames
    .filter((f) => f.name && !f.name.startsWith("_") && !f.name.startsWith("."))
    .map((f) => ({
      route: frameNameToRoute(f.name),
      title: f.name,
      frameId: f.id,
      sectionHints: frameToSectionHints(f),
    }));

  const latencyMs = now() - started;
  const scraped: FigmaImportScrapedResult = {
    fileKey,
    fileName: file.name ?? "",
    lastModified: file.lastModified ?? "",
    topLevelFrames,
    colors,
    fonts,
    suggestedBriefPages,
    latencyMs,
  };

  const briefSuggestion = nodesToBriefSuggestion(topLevelFrames);
  const anythingUseful =
    topLevelFrames.length > 0 ||
    colors.length > 0 ||
    fonts.length > 0 ||
    !!briefSuggestion;
  if (!anythingUseful) {
    if (userId) {
      trackEvent("figma_import_failed", userId, userRole, {
        file_key: fileKey,
        reason: "empty_result",
      });
    }
    return {
      ok: false,
      reason: "empty_result",
      scraped,
      briefSuggestion: null,
    };
  }

  if (userId) {
    trackEvent("figma_import_completed", userId, userRole, {
      file_key: fileKey,
      frame_count: topLevelFrames.length,
      color_count: colors.length,
      font_count: fonts.length,
      latency_ms: latencyMs,
    });
  }

  return {
    ok: true,
    reason: "ok",
    scraped,
    briefSuggestion,
  };
}

/* --------------------------------------------------------------------- *
 * Internals
 * --------------------------------------------------------------------- */

function empty(reason: FigmaImportReason): FigmaImportResult {
  return {
    ok: false,
    reason,
    scraped: null,
    briefSuggestion: null,
  };
}
