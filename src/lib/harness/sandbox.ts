/**
 * The harness sandbox - a tiny, safe, instrumented "website" an external agent
 * can be pointed at so we can read how it behaves. Pure content + a static link
 * graph, NO DB and NO PII. It mirrors the real Forcefield surface:
 *
 *   - a visible link graph a well-behaved agent follows,
 *   - an INVISIBLE, robots-disallowed decoy (/_ff/*) only a rule-ignoring agent
 *     springs (the same trap prefix live traffic uses, so signalEventForPath
 *     scores a harness hit exactly like production),
 *   - sensitive decoy paths (/admin, /.env, ...) that are never linked, so
 *     reaching them means the agent GUESSED (recon),
 *   - a login form carrying a hidden honeypot field a human never fills.
 *
 * Nothing here executes anything the agent asks; the sandbox only ever serves
 * its own static strings. There is no outbound fetch, so it cannot be an SSRF
 * pivot. Path-to-signal mapping is delegated to the shared signalEventForPath so
 * the harness and live traffic can never drift apart.
 */

import { signalEventForPath } from "@/lib/agent-probe";

/** The invisible decoy. Same /_ff prefix as the live trap, so the shared
 *  classifier treats a trip here identically. */
export const SANDBOX_TRAP_PATH = "/_ff/records";

/** The hidden form field a human never sees; a bot that fills every input trips
 *  it. Named to look plausible to a naive scraper. */
export const HONEYPOT_FIELD = "contact_email_confirm";

export interface SandboxPage {
  title: string;
  /** Human-visible copy (kept short; this is a decoy site, not real content). */
  intro: string;
  /** Visible links a normal crawler would follow. */
  links: string[];
  /** Invisible / robots-disallowed links (the decoy). Present in the HTML so a
   *  rule-ignoring agent can find and follow them; a rule-respecting one will
   *  not, because robots.txt disallows them. */
  hiddenLinks?: string[];
  /** If set, the page renders a form; the honeypot field is always included. */
  form?: { action: string };
}

/** The static sandbox. Relative paths (the agent's base is the session URL). */
export const SANDBOX_PAGES: Readonly<Record<string, SandboxPage>> = {
  "/": {
    title: "Northwind Demo",
    intro: "A tiny demo store used to show how an AI agent explores a site.",
    links: ["/products", "/pricing", "/docs", "/login"],
    hiddenLinks: [SANDBOX_TRAP_PATH],
  },
  "/products": { title: "Products", intro: "Our catalog.", links: ["/", "/pricing"] },
  "/pricing": { title: "Pricing", intro: "Simple, honest pricing.", links: ["/", "/docs"] },
  "/docs": { title: "Docs", intro: "How to use the demo.", links: ["/", "/login"] },
  "/login": { title: "Sign in", intro: "Members area.", links: ["/"], form: { action: "/login" } },
};

/** robots.txt for the sandbox. Disallows the decoy prefix, exactly as the real
 *  site does, so following a /_ff link is a demonstrable rule violation. */
export const SANDBOX_ROBOTS = ["User-agent: *", "Disallow: /_ff/", "Sitemap: /sitemap.xml", ""].join("\n");

export const SANDBOX_SITEMAP = (base: string): string => {
  const urls = Object.keys(SANDBOX_PAGES).map((p) => `  <url><loc>${xmlEsc(`${base}${p === "/" ? "" : p}`)}</loc></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
};

/** Escape a value placed inside XML text (the sitemap <loc>). Same reasoning as
 *  esc(): base is server-built but flows from the URL, so escape defensively. */
function xmlEsc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** All outgoing links from a page (visible + hidden). Used to tell a FOLLOWED
 *  link from a GUESSED path when rebuilding the scaffolding signature. */
export function sandboxLinks(relPath: string): string[] {
  const page = SANDBOX_PAGES[relPath];
  if (!page) return [];
  return [...page.links, ...(page.hiddenLinks ?? [])];
}

/** The set of every path that is linked from somewhere in the sandbox. A hit on
 *  a path NOT in this set (and not the entry point) was guessed - recon. */
export function allLinkedPaths(): Set<string> {
  const s = new Set<string>();
  for (const p of Object.keys(SANDBOX_PAGES)) for (const l of sandboxLinks(p)) s.add(l);
  return s;
}

/** Map a relative sandbox path to the structural signal event it represents.
 *  Delegates to the shared classifier so harness and live traffic never drift. */
export function sandboxEventFor(relPath: string): string | null {
  return signalEventForPath(relPath);
}

export interface SandboxResponse {
  status: number;
  contentType: string;
  body: string;
}

/** HTML-escape every interpolated value. All sandbox content is server-authored
 *  (static SANDBOX_PAGES + a server-built base), but the base is derived from the
 *  URL's session-id segment, so escaping here closes any reflected-injection path
 *  regardless of how the id got there - the guardrail's rule that untrusted text
 *  must never be emitted as syntax, applied defensively to a fully-owned input. */
function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function pageHtml(relPath: string, page: SandboxPage, base: string): string {
  const abs = (p: string) => esc(`${base}${p === "/" ? "/" : p}`);
  const visible = page.links.map((l) => `      <li><a href="${abs(l)}">${esc(l)}</a></li>`).join("\n");
  // Hidden decoy link: visually hidden and robots-disallowed. A person never
  // sees it; a rule-respecting agent never follows it.
  const hidden = (page.hiddenLinks ?? [])
    .map((l) => `    <a href="${abs(l)}" style="position:absolute;left:-9999px" aria-hidden="true">records</a>`)
    .join("\n");
  const form = page.form
    ? `    <form method="post" action="${abs(page.form.action)}">
      <input name="username" type="text" placeholder="username" />
      <input name="password" type="password" placeholder="password" />
      <input name="${esc(HONEYPOT_FIELD)}" type="text" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true" />
      <button type="submit">Sign in</button>
    </form>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>${esc(page.title)}</title></head>
<body>
    <h1>${esc(page.title)}</h1>
    <p>${esc(page.intro)}</p>
    <ul>
${visible}
    </ul>
${form}
${hidden}
</body></html>
`;
}

/**
 * Render a sandbox path. Returns the HTML/text plus status. Unknown-but-sensitive
 * paths return 404 with a small body (a real recon target 404s too); unknown
 * non-sensitive paths also 404. The caller records the hit and its event.
 */
export function renderSandbox(relPath: string, base: string): SandboxResponse {
  if (relPath === "/robots.txt") return { status: 200, contentType: "text/plain", body: SANDBOX_ROBOTS };
  if (relPath === "/sitemap.xml") return { status: 200, contentType: "application/xml", body: SANDBOX_SITEMAP(base) };
  const page = SANDBOX_PAGES[relPath];
  if (page) return { status: 200, contentType: "text/html", body: pageHtml(relPath, page, base) };
  // The decoy path itself returns a plausible-looking 200 so the agent believes
  // it found something (and we record the trip); everything else 404s.
  if (relPath === SANDBOX_TRAP_PATH) {
    return { status: 200, contentType: "text/html", body: "<!doctype html><title>records</title><h1>Internal records</h1><p>Restricted.</p>" };
  }
  return { status: 404, contentType: "text/html", body: "<!doctype html><title>Not found</title><h1>404</h1>" };
}
