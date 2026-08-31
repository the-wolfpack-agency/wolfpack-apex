/**
 * A test for the test.
 *
 * The verify smoke sat on main reporting failure from 2026-06-28 to
 * 2026-08-24 while production was healthy, because probePath read the page
 * body once, the instant after domcontentloaded, and every authenticated
 * route says "Loading Instinct…" at that moment. Two probes expected a
 * fragment the splash contains and therefore could never fail; the first
 * probe that asked for real content failed on a page that rendered fine a
 * second later.
 *
 * Fixing probePath is not enough on its own. The fix is a timing behavior,
 * and timing behavior is exactly what quietly regresses: somebody swaps the
 * poll back for a single read, every probe still passes against a fast local
 * server, and nobody learns otherwise until production is slow.
 *
 * So these two cases pin the behavior against a server whose timing we
 * control. Neither needs credentials, a deployment, or a network.
 */
import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { probePath, type SmokeTarget } from "./helpers/smoke-helpers";
import { BOOT_SPLASH_TESTID, BOOT_SPLASH_TEXT } from "@/lib/ui/boot-splash";
import { PROBES, PUBLIC_LANDING_PROBE } from "./helpers/smoke-probes";

/** A page that shows the splash, then reveals content after `revealAfterMs`.
 *  Pass null to never reveal, which is what a genuinely broken boot looks
 *  like. */
function splashThen(revealAfterMs: number | null, content: string): string {
  const reveal =
    revealAfterMs === null
      ? ""
      : `setTimeout(function () {
           document.body.innerHTML = ${JSON.stringify(content)};
         }, ${revealAfterMs});`;
  return `<!doctype html><html><head><title>t</title></head><body>
    <div data-testid="${BOOT_SPLASH_TESTID}">${BOOT_SPLASH_TEXT}</div>
    <script>${reveal}</script>
  </body></html>`;
}

async function serve(html: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const targetFor = (baseUrl: string): SmokeTarget => ({ baseUrl, isProduction: false });

test.describe("probePath timing", () => {
  test("waits out the boot splash instead of reading it", async ({ page }) => {
    // Two seconds is far longer than the gap probePath used to leave, and far
    // shorter than a real boot. If probePath samples once, this fails.
    const app = await serve(splashThen(2_000, "<h1>Tasks</h1>"));
    try {
      await probePath(page, targetFor(app.baseUrl), { path: "/", expectText: "Task" });
    } finally {
      await app.close();
    }
  });

  test("a page that never leaves the splash fails, and says that", async ({ page }) => {
    const app = await serve(splashThen(null, ""));
    try {
      const error = await probePath(page, targetFor(app.baseUrl), {
        path: "/",
        expectText: "Task",
        contentTimeoutMs: 2_000,
      }).then(
        () => null,
        (e: Error) => e,
      );
      expect(error, "a page stuck on the splash must fail the probe").not.toBeNull();
      // The wording matters as much as the failure. "text not found" sent
      // somebody looking at /tasks for two months; the page had never booted.
      expect(error?.message).toContain("never finished booting");
    } finally {
      await app.close();
    }
  });

  test("the splash alone does not satisfy a probe that asks for its words", async ({ page }) => {
    // The exact shape of the original bug: expect a fragment the splash
    // contains, against a page that only ever shows the splash. It must fail.
    const app = await serve(splashThen(null, ""));
    try {
      const error = await probePath(page, targetFor(app.baseUrl), {
        path: "/",
        expectText: "Instinct",
        contentTimeoutMs: 2_000,
      }).then(
        () => null,
        (e: Error) => e,
      );
      expect(
        error,
        'expecting "Instinct" passed on a blank screen for two months; it must not again',
      ).not.toBeNull();
    } finally {
      await app.close();
    }
  });
});

/**
 * A probe whose expected text appears in the boot splash cannot fail, and a
 * check that cannot fail is worse than no check: it reports health.
 *
 * Two of the ten probes were in that state from 2026-06-28 to 2026-08-24.
 * `/` and `/setup` both expected the fragment "Instinct", which is inside
 * "Loading Instinct…", so they passed against a screen that had rendered
 * nothing at all. This costs nothing, needs no browser, no credentials and no
 * deployment, and would have caught it the day it was written.
 */
test.describe("probe expectations are real", () => {
  test("no probe can be satisfied by the loading splash", async () => {
    const splash = BOOT_SPLASH_TEXT.toLowerCase();
    const offenders: string[] = [];
    for (const probe of [...PROBES, PUBLIC_LANDING_PROBE]) {
      for (const c of probe.expectAnyText ?? [probe.expectText]) {
        if (splash.includes(c.toLowerCase())) {
          offenders.push(`${probe.path} expects ${JSON.stringify(c)}`);
        }
      }
    }
    expect(
      offenders,
      `Satisfied by the boot splash ${JSON.stringify(BOOT_SPLASH_TEXT)}, so they ` +
        `pass on a page that has rendered nothing:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
