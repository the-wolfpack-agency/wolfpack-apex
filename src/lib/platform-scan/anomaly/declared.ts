/**
 * What a site can EXPLAIN about its own outbound traffic.
 *
 * observations.ts already answers "which hosts did this page contact, and which
 * of them are unexplained" — but `unexplained()` takes a `declaredHosts` list
 * that nothing produced, so it had no caller. This is the missing half: it
 * derives that list from evidence, rather than from someone maintaining a
 * spreadsheet.
 *
 * WHERE THE EVIDENCE COMES FROM
 *
 * The strongest source is the site's OWN Content-Security-Policy. A CSP is a
 * machine-readable statement of intent: `connect-src` and `script-src` are
 * literally the site saying "these are the hosts I mean to talk to". Comparing
 * observed traffic against it asks a sharp question — is this site doing what
 * it declared it would do? No extra configuration, and the answer improves as
 * the client's own security posture improves.
 *
 * The compliance collector already captures response headers, so this reads
 * evidence that is being gathered anyway rather than adding a crawl.
 *
 * PROVENANCE IS PART OF THE ANSWER
 *
 * Every declared host records WHY it is explained. "The site's CSP permits it"
 * and "an operator added it to a list once" are both explanations, but they are
 * not equally good ones, and a report that flattens them into a single boolean
 * cannot tell a reviewer which findings to trust. detect.ts reads the source
 * when it weighs severity.
 *
 * A WILDCARD THAT EXPLAINS EVERYTHING EXPLAINS NOTHING
 *
 * `connect-src *` or `script-src https:` is not a declaration of intent, it is
 * the absence of one. Treating it as an explanation would mark every site with
 * a permissive CSP as perfectly clean — the sites most likely to have a problem
 * would produce the emptiest reports. Those directives are recorded as
 * `permissive` and deliberately explain nothing.
 *
 * Pure. No network, no database, no browser.
 */
import { hostOf, rootDomain } from "../network/observations";

/** Why a host counts as explained. Ordered weakest to strongest in intent. */
export type DeclarationSource =
  /** An operator listed it by hand. A person's assertion, not the site's. */
  | "operator"
  /** The site's own origin, or a subdomain of it. */
  | "self"
  /** Named in the site's Content-Security-Policy. The site's own declaration. */
  | "csp"
  /** A host belonging to a dependency or integration the site is known to use. */
  | "integration";

export interface DeclaredHost {
  /** Lowercased, www-stripped. May start with "." to mean "and subdomains". */
  host: string;
  source: DeclarationSource;
  /** Human-readable origin of the claim, e.g. "csp: connect-src". */
  detail: string;
}

export interface DeclarationSet {
  hosts: DeclaredHost[];
  /**
   * Directives that permitted everything, so were not used as explanations.
   * Surfaced rather than swallowed: "this site's CSP allows any host" is itself
   * worth telling a client, and it explains why their anomaly list is long.
   */
  permissive: string[];
  /**
   * True when NO usable declaration was found at all. Distinct from "found a
   * declaration that happened to be empty" — one means we could not ask the
   * question, the other means the site answered "nothing". detect.ts refuses to
   * call anything anomalous in the first case.
   */
  noEvidence: boolean;
}

/** Source expressions that permit any host, so cannot explain a specific one. */
const PERMISSIVE = new Set(["*", "https:", "http:", "data:", "blob:"]);

/** Keywords that are not hosts. 'self' is handled separately, by origin. */
const KEYWORDS = new Set([
  "'self'",
  "'none'",
  "'unsafe-inline'",
  "'unsafe-eval'",
  "'strict-dynamic'",
  "'unsafe-hashes'",
  "'report-sample'",
  "'wasm-unsafe-eval'",
]);

/** Directives that describe outbound contact. `img-src` and `font-src` are
 *  included because a tracking pixel is an image and a beacon can be a font
 *  request; excluding them would leave the oldest tracking technique in the
 *  book unexplained-but-invisible. */
const CONTACT_DIRECTIVES = ["connect-src", "script-src", "img-src", "frame-src", "font-src", "media-src", "default-src"];

/**
 * Parse a CSP header into directive -> source list.
 *
 * engine.ts only regex-tests the CSP for `frame-ancestors`, so there was no
 * parser to reuse. If engine.ts ever needs structure, it should adopt this one
 * rather than growing a second.
 */
export function parseCsp(header: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const chunk of header.split(";")) {
    const parts = chunk.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const name = parts[0].toLowerCase();
    // A repeated directive is invalid CSP; browsers honour the FIRST. Matching
    // the browser matters: an attacker appending a permissive duplicate must not
    // widen what we consider declared.
    if (!out.has(name)) out.set(name, parts.slice(1));
  }
  return out;
}

/**
 * Turn one CSP source expression into a host, or explain why it is not one.
 *
 * `*.example.com` becomes `.example.com`, meaning "example.com and below".
 * A bare `*.` prefix on its own (`*.`) is nonsense and is rejected rather than
 * being read as "everything".
 */
export function hostFromCspSource(src: string): { host: string } | { permissive: true } | null {
  const s = src.trim().toLowerCase();
  if (!s || KEYWORDS.has(s) || s.startsWith("'")) return null;
  if (PERMISSIVE.has(s)) return { permissive: true };
  // Scheme-qualified wildcards: https://* is as permissive as *.
  if (/^[a-z][a-z0-9+.-]*:\/\/\*$/.test(s)) return { permissive: true };

  let rest = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  rest = rest.split("/")[0].replace(/:\d+$/, "");
  if (rest.startsWith("*.")) {
    const base = rest.slice(2);
    // "*." alone, or "*.com", declares an entire TLD. Not a declaration.
    if (!base || !base.includes(".")) return { permissive: true };
    return { host: `.${base.replace(/^www\./, "")}` };
  }
  if (!rest || rest.includes("*")) return null;
  if (!rest.includes(".")) return null; // bare token, not a host
  return { host: rest.replace(/^www\./, "") };
}

export interface DeclarationInput {
  /** The scanned page URL, so the site's own origin explains itself. */
  pageUrl: string;
  /** Response headers as collected. Keys are matched case-insensitively. */
  headers?: Record<string, string> | null;
  /** Hosts an operator has vouched for, e.g. from the target's onboarding record. */
  operatorAllowed?: readonly string[];
  /** Hosts implied by integrations the client is known to run. */
  integrationHosts?: readonly { host: string; name: string }[];
}

/**
 * Assemble everything the system can use to explain a request.
 *
 * Report-only CSP counts. A site running `Content-Security-Policy-Report-Only`
 * is still stating what it believes it contacts, and that statement is exactly
 * as useful for this question as an enforced one — the difference is whether
 * the browser blocks, not whether the intent was declared.
 */
export function buildDeclarations(input: DeclarationInput): DeclarationSet {
  const hosts: DeclaredHost[] = [];
  const permissive: string[] = [];
  const seen = new Set<string>();

  const add = (host: string, source: DeclarationSource, detail: string) => {
    const key = `${host}|${source}`;
    if (seen.has(key)) return;
    seen.add(key);
    hosts.push({ host, source, detail });
  };

  const own = hostOf(input.pageUrl);
  if (own) {
    add(own, "self", "the site's own origin");
    // A subdomain of the site is the site. Not a third party by any reading.
    add(`.${rootDomain(own)}`, "self", "a subdomain of the site");
  }

  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(input.headers ?? {})) lower.set(k.toLowerCase(), v);

  let sawCsp = false;
  for (const name of ["content-security-policy", "content-security-policy-report-only"]) {
    const raw = lower.get(name);
    if (!raw) continue;
    sawCsp = true;
    const directives = parseCsp(raw);
    for (const directive of CONTACT_DIRECTIVES) {
      const sources = directives.get(directive);
      if (!sources) continue;
      for (const src of sources) {
        const parsed = hostFromCspSource(src);
        if (!parsed) continue;
        if ("permissive" in parsed) {
          const label = `${directive} ${src}`;
          if (!permissive.includes(label)) permissive.push(label);
          continue;
        }
        add(parsed.host, "csp", `csp: ${directive}`);
      }
    }
  }

  for (const i of input.integrationHosts ?? []) {
    const h = i.host.toLowerCase().replace(/^www\./, "");
    if (h) add(h, "integration", `integration: ${i.name}`);
  }
  for (const h of input.operatorAllowed ?? []) {
    const clean = h.toLowerCase().trim().replace(/^www\./, "");
    if (clean) add(clean, "operator", "operator allowlist");
  }

  // "self" alone is not evidence about third parties: every site explains its
  // own origin, so a report built on that alone would call every third party
  // anomalous on every site. Evidence means something that speaks to OTHERS.
  const noEvidence =
    !sawCsp && (input.integrationHosts ?? []).length === 0 && (input.operatorAllowed ?? []).length === 0;

  return { hosts, permissive, noEvidence };
}

/** Does this declaration cover this host? A leading dot means "and below". */
export function explains(declared: DeclaredHost, host: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  if (declared.host.startsWith(".")) {
    const base = declared.host.slice(1);
    // Dot-boundary, matching identify(): "evil-hotjar.com" is not under hotjar.com.
    return h === base || h.endsWith(`.${base}`);
  }
  return h === declared.host;
}

/** The best explanation for a host, or null when nothing accounts for it. */
export function explanationFor(set: DeclarationSet, host: string): DeclaredHost | null {
  const rank: Record<DeclarationSource, number> = { integration: 3, csp: 2, self: 1, operator: 0 };
  let best: DeclaredHost | null = null;
  for (const d of set.hosts) {
    if (!explains(d, host)) continue;
    if (!best || rank[d.source] > rank[best.source]) best = d;
  }
  return best;
}

/** Flattened form for `unexplained()` in observations.ts, which takes plain
 *  strings. Leading dots are stripped because that helper already treats a
 *  declared host as covering its subdomains. */
export function declaredHostList(set: DeclarationSet): string[] {
  return [...new Set(set.hosts.map((d) => (d.host.startsWith(".") ? d.host.slice(1) : d.host)))];
}
