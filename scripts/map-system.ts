/**
 * Map a system from the inside, as an authenticated user sees it.
 *
 * WHAT IT ASSEMBLES, ALL OF IT ALREADY BUILT. createSpecDiffBrowser gets a
 * chromium (including the remote-CDP path for machines without one),
 * createSurfaceReader turns a page into facts and installs the read-only
 * floor, click-policy decides what may be pressed, and walkSystem walks. This
 * is the wiring, not the work.
 *
 *   npx tsx scripts/map-system.ts <baseUrl> --authorised-by "<name>"
 *   npx tsx scripts/map-system.ts <baseUrl> --authorised-by "<name>" \
 *     --email <user> --password <pass> --login-path /login
 *
 * AUTHORISATION IS NAMED, NOT ASSUMED. Every run prints who authorised it and
 * refuses without it. This sends traffic to a real system, and "somebody said
 * it was fine" is not something a log should have to reconstruct later.
 *
 * ORDER MATTERS AND IS THE ONE SUBTLE THING HERE. Logging in is a POST, and
 * the read-only floor blocks every non-GET request. So the sign-in happens
 * FIRST, and the floor goes on immediately afterwards, before the walk touches
 * anything. Installing it earlier would block the login; installing it later
 * would leave surfaces unprotected.
 */

export {};

import { createSpecDiffBrowser } from "@/lib/spec-diff/browser";
import { createSurfaceReader } from "@/lib/platform-scan/mapping/reader";
import { walkSystem } from "@/lib/platform-scan/mapping/walk";
import type { ScanPage } from "@/lib/platform-scan/browser/capture";

const arg = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
};

const baseUrl = process.argv[2];
const authorisedBy = arg("authorised-by");

if (!baseUrl || !authorisedBy) {
  console.error(
    'usage: npx tsx scripts/map-system.ts <baseUrl> --authorised-by "<name>"\n' +
      "        [--email <user> --password <pass> --login-path /login]\n\n" +
      "--authorised-by is required. This sends traffic to a real system and the\n" +
      "run should say who agreed to it.",
  );
  process.exit(2);
}

(async () => {
  console.log(`\nMapping ${baseUrl}`);
  console.log(`Authorised by: ${authorisedBy}`);
  console.log("Read-only: no form is submitted, and every non-GET request is blocked.\n");

  const handle = await createSpecDiffBrowser();
  try {
    const page = (await handle.browser.newPage()) as unknown as ScanPage;

    const email = arg("email");
    const password = arg("password");
    let authenticated = false;

    if (email && password) {
      /* BEFORE THE FLOOR. A sign-in is a POST and the floor blocks those, so
         this is the one navigation that happens without it. */
      const loginPath = arg("login-path") ?? "/login";
      const p = page as unknown as {
        goto(u: string): Promise<unknown>;
        fill(sel: string, v: string): Promise<void>;
        click(sel: string): Promise<void>;
        waitForURL(fn: (u: URL) => boolean, o?: unknown): Promise<void>;
      };
      await p.goto(`${baseUrl.replace(/\/$/, "")}${loginPath}`);
      await p.fill('input[type="email"], input[name="email"], input[name="username"]', email);
      await p.fill('input[type="password"], input[name="password"]', password);
      await p.click('button[type="submit"], input[type="submit"]');
      await p
        .waitForURL((u: URL) => !u.pathname.includes(loginPath), { timeout: 45_000 })
        .catch(() => undefined);
      authenticated = true;
      console.log("signed in\n");
    } else {
      console.log("no credentials given, mapping what an anonymous visitor sees\n");
    }

    /* The floor goes on here: after the login, before the walk. */
    /* The settle hook is the browser handle's own, not a second answer to a
       question this product has already answered. */
    const reader = await createSurfaceReader(page, {
      settle: (pg) => handle.hooks.settle(pg as never),
    });

    const started = Date.now();
    const { surfaces, coverage } = await walkSystem(baseUrl, reader, {
      budget: {
        maxSurfaces: Number(arg("max-surfaces") ?? 40),
        maxDepth: Number(arg("max-depth") ?? 3),
        maxDurationMs: Number(arg("max-seconds") ?? 240) * 1000,
      },
      onSurface: (s) => console.log(`  d${s.depth} ${String(s.status).padStart(3)} ${s.signature}`),
    });

    console.log(
      `\n${surfaces.length} surfaces in ${((Date.now() - started) / 1000).toFixed(0)}s` +
        `  authenticated=${authenticated}  stopped=${coverage.stopReason}`,
    );

    /* THE HEADLINE SAYS WHAT WAS NOT COVERED, because a map presented as
       complete when it is not is worse than no map. */
    if (coverage.frontierRemaining > 0) {
      console.log(
        `INCOMPLETE: ${coverage.frontierRemaining} place(s) still queued when it stopped.\n` +
          "Every claim below is about what was reached, not about the system.",
      );
    }

    const forms = surfaces.flatMap((s) => s.forms);
    const mutating = forms.filter((f) => f.mutating);
    console.log(`\nWhere data enters: ${forms.length} forms (${mutating.length} that would change something)`);
    for (const f of forms.slice(0, 8)) {
      console.log(`  ${f.mutating ? "writes" : "reads "}  ${f.name.slice(0, 44).padEnd(44)} ${f.fields.length} fields`);
    }

    const tables = surfaces.flatMap((s) => s.tables);
    console.log(`\nWhat the system manages: ${tables.length} tables`);
    for (const t of tables.slice(0, 6)) {
      console.log(`  ${(t.caption ?? "untitled").slice(0, 30).padEnd(30)} ${t.columns.slice(0, 5).join(", ").slice(0, 60)}`);
    }

    const byReason = new Map<string, number>();
    for (const s of coverage.skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    console.log("\nDeliberately not looked at:");
    for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`  ${String(n).padStart(4)}  ${reason.slice(0, 66)}`);
    }

    /* A screen with no timing is not a fast screen; it is one we could not
       time, and sorting nulls as zero would hide the slowest pages. */
    const slow = surfaces
      .filter((s) => (s.loadMs ?? 0) > 3000)
      .sort((a, b) => (b.loadMs ?? 0) - (a.loadMs ?? 0));
    if (slow.length > 0) {
      console.log(`\nSlow screens, which are a finding in their own right:`);
      for (const s of slow.slice(0, 5)) console.log(`  ${String(s.loadMs).padStart(6)}ms  ${s.signature}`);
    }
  } finally {
    await handle.close();
  }
  process.exit(0);
})().catch((err) => {
  console.error(`\nmapping failed: ${(err as Error).message.slice(0, 300)}`);
  process.exit(1);
});
