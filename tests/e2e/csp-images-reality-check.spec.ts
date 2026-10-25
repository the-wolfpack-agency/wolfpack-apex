/**
 * CSP img-src narrowing, proven in a real browser against the deployed app.
 *
 * WHAT IT GUARDS. `img-src` used to allow any https host, which made any image
 * URL in model output a zero-click request to whoever wrote it. It now names
 * the hosts the app uses (src/lib/csp-image-hosts.ts). Narrowing a CSP is the
 * change most likely to blank a page or drop an image without any unit test
 * noticing, so this drives the main authenticated pages and asserts:
 *   - the document answers HTTP 200 (not just "not 500"; a 401 is a blank page),
 *   - the page actually renders (boot splash gone, page marker visible),
 *   - every <img> on the page finished loading with real pixels,
 *   - zero CSP violations in the console,
 *   - the served img-src carries no wildcard https source.
 *
 * THE POLICY UNDER TEST IS THE ONE IN THE CODE. The reality check targets the
 * live deployment, which on a PR still serves the previous header. So each
 * document response is re-served with its img-src replaced by the directive
 * this commit builds (imgSrcDirective from src/lib/csp-image-hosts.ts), and the
 * browser enforces that. Every other byte and header is the deployed one. Once
 * the change is live the replacement is a no-op, and the deployed header is
 * additionally required to equal it.
 *
 * NO CREDENTIALS NEEDED: the session is stubbed (stubInstinctSession, which also
 * answers /api/auth/mfa/status), so the REAL deployed bundle renders the REAL
 * layout. Data calls a stub token cannot make answer 401 and the pages show
 * their own empty or unavailable states, which is part of what is checked:
 * a widget that blanks instead of saying so fails the render assertion.
 */
import { test, expect, type Page } from "@playwright/test";
import { imgSrcDirective } from "@/lib/csp-image-hosts";
import {
  resolveSmokeTarget,
  stubInstinctSession,
  collectConsoleAndNetworkFailures,
  expectRendered,
} from "./helpers/smoke-helpers";

const target = resolveSmokeTarget();

interface PageCase {
  path: string;
  name: string;
  /** Text any honest render of the page contains (content or empty state). */
  rendered: string[];
}

const PAGES: PageCase[] = [
  { path: "/", name: "dashboard", rendered: ["instinct"] },
  { path: "/assistant", name: "assistant", rendered: ["assistant", "instinct"] },
  { path: "/support", name: "support", rendered: ["support"] },
];

function imgSrcOf(csp: string): string[] {
  const d = csp
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("img-src "));
  return d ? d.split(/\s+/).slice(1) : [];
}

/** Serve each document with the img-src this commit builds. Returns the policy
 *  the deployment itself sent, for the post-deploy equality check. */
async function enforceCodePolicy(page: Page): Promise<{ deployed: () => string }> {
  let deployed = "";
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const response = await route.fetch();
    const headers = { ...response.headers() };
    const original = headers["content-security-policy"] ?? "";
    deployed = original;
    const path = new URL(route.request().url()).pathname;
    headers["content-security-policy"] = original
      .split(";")
      .map((d) => (d.trim().startsWith("img-src ") ? ` ${imgSrcDirective(path)}` : d))
      .join(";");
    await route.fulfill({ response, headers });
  });
  return { deployed: () => deployed };
}

/** Every <img> in the DOM: whether it loaded with real pixels. */
async function imageStates(page: Page) {
  return page.evaluate(() =>
    Array.from(document.images).map((img) => ({
      src: img.currentSrc || img.src,
      complete: img.complete,
      width: img.naturalWidth,
    })),
  );
}

test.describe("CSP img-src narrowing keeps the main pages rendering", () => {
  for (const pc of PAGES) {
    test(`${pc.name} (${pc.path}): 200, renders, images load, 0 CSP violations`, async ({ page }) => {
      const policy = await enforceCodePolicy(page);
      await stubInstinctSession(page, { role: "admin" });
      const failures = collectConsoleAndNetworkFailures(page);

      const res = await page.goto(`${target.baseUrl}${pc.path}`, { waitUntil: "domcontentloaded" });
      expect(res?.status(), `${pc.path} document status`).toBe(200);

      await expectRendered(page, pc.path, pc.rendered);
      /* The authenticated layout drew (not a redirect to /login). */
      expect(new URL(page.url()).pathname, `${pc.path} was redirected`).toBe(pc.path);
      await expect(page.locator('img[alt="OGIAM"]').first()).toBeAttached({ timeout: 15_000 });
      if (pc.name === "support") {
        await expect(page.getByTestId("support-page")).toBeVisible({ timeout: 20_000 });
      }

      /* Give lazy images a moment, then every image must have loaded. */
      await page.waitForLoadState("load").catch(() => null);
      await page
        .waitForFunction(() => Array.from(document.images).every((i) => i.complete), null, { timeout: 15_000 })
        .catch(() => null);
      const images = await imageStates(page);
      expect(images.length, `${pc.path} rendered no images at all`).toBeGreaterThan(0);
      const broken = images.filter((i) => !i.complete || i.width === 0);
      expect(broken, `${pc.path} has images that did not load`).toEqual([]);

      const csp = failures().filter((f) => f.detail.startsWith("CSP:"));
      expect(csp, `CSP violations on ${pc.path}:\n${csp.map((f) => f.detail).join("\n")}`).toEqual([]);
      const crashes = failures().filter((f) => f.detail.startsWith("pageerror:"));
      expect(crashes, `uncaught errors on ${pc.path}`).toEqual([]);

      /* The policy the browser enforced: no wildcard https. */
      const enforced = imgSrcOf(res?.headers()["content-security-policy"] ?? "");
      expect(enforced, `${pc.path} enforced img-src`).toEqual(imgSrcDirective(pc.path).split(/\s+/).slice(1));
      for (const bad of ["https:", "http:", "*", "https://*"]) expect(enforced).not.toContain(bad);

      /* What the deployment sent. Before this change ships it still carries
         the old `https:`; recorded so the run shows which policy is live. Once
         it is narrowed it must equal the code. */
      const deployed = imgSrcOf(policy.deployed());
      test.info().annotations.push({ type: "deployed img-src", description: deployed.join(" ") || "(none)" });
      if (!deployed.includes("https:")) expect(deployed).toEqual(enforced);
    });
  }
});
