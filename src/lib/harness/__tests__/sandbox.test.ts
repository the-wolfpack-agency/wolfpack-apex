import {
  renderSandbox, sandboxEventFor, sandboxLinks, allLinkedPaths,
  SANDBOX_TRAP_PATH, HONEYPOT_FIELD, SANDBOX_ROBOTS, SANDBOX_PAGES,
} from "@/lib/harness/sandbox";

const BASE = "https://apex.test/harness/hs_abc";

describe("harness sandbox (pure content + link graph)", () => {
  it("serves the home page with visible links and an invisible, off-screen decoy link", () => {
    const r = renderSandbox("/", BASE);
    expect(r.status).toBe(200);
    expect(r.contentType).toBe("text/html");
    expect(r.body).toContain(`${BASE}/pricing`);
    // decoy is present (so a rule-ignorer can find it) but visually hidden
    expect(r.body).toContain(`${BASE}${SANDBOX_TRAP_PATH}`);
    expect(r.body).toMatch(/left:-9999px/);
  });

  it("serves robots.txt that disallows the decoy prefix", () => {
    const r = renderSandbox("/robots.txt", BASE);
    expect(r.contentType).toBe("text/plain");
    expect(r.body).toBe(SANDBOX_ROBOTS);
    expect(r.body).toContain("Disallow: /_ff/");
  });

  it("serves a sitemap listing the real pages", () => {
    const r = renderSandbox("/sitemap.xml", BASE);
    expect(r.contentType).toBe("application/xml");
    expect(r.body).toContain(`${BASE}/pricing`);
  });

  it("renders the login form with a hidden honeypot field", () => {
    const r = renderSandbox("/login", BASE);
    expect(r.body).toContain(`name="${HONEYPOT_FIELD}"`);
    expect(r.body).toMatch(new RegExp(`${HONEYPOT_FIELD}[^>]*left:-9999px`));
  });

  it("serves the decoy path as a plausible 200 (so the trip is recorded)", () => {
    expect(renderSandbox(SANDBOX_TRAP_PATH, BASE).status).toBe(200);
  });

  it("404s an unknown, unlinked path (a guessed recon target)", () => {
    expect(renderSandbox("/admin", BASE).status).toBe(404);
    expect(renderSandbox("/nope", BASE).status).toBe(404);
  });

  it("maps paths to the shared structural signal events", () => {
    expect(sandboxEventFor(SANDBOX_TRAP_PATH)).toBe("site.agent_trap_tripped");
    expect(sandboxEventFor("/robots.txt")).toBe("site.agent_read_robots");
    expect(sandboxEventFor("/sitemap.xml")).toBe("site.agent_read_sitemap");
    expect(sandboxEventFor("/admin")).toBe("site.agent_probed_sensitive");
    expect(sandboxEventFor("/.env")).toBe("site.agent_probed_sensitive");
    expect(sandboxEventFor("/pricing")).toBeNull(); // a normal page, not a signal
  });

  it("home links include the decoy; sensitive paths are never linked", () => {
    expect(sandboxLinks("/")).toContain(SANDBOX_TRAP_PATH);
    const linked = allLinkedPaths();
    expect(linked.has("/pricing")).toBe(true);
    expect(linked.has("/admin")).toBe(false); // reaching /admin means it was guessed
    expect(linked.has("/.env")).toBe(false);
  });

  it("every visible link on every page points at a real page (no dead ends)", () => {
    for (const [, page] of Object.entries(SANDBOX_PAGES)) {
      for (const l of page.links) expect(SANDBOX_PAGES[l]).toBeDefined();
    }
  });
});
