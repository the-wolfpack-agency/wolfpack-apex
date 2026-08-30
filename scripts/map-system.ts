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
 *     --email <user> --login-path /login
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
import { promptSecret } from "@/lib/cli/prompt-secret";
import { waitForEnter } from "@/lib/cli/wait-for-enter";
import { withSecret, scrubSecret } from "@/lib/cli/scrub-secret";
import { createSurfaceReader } from "@/lib/platform-scan/mapping/reader";
import { walkSystem } from "@/lib/platform-scan/mapping/walk";
import { inventoryForms } from "@/lib/platform-scan/mapping/form-inventory";
import { inferEntities } from "@/lib/platform-scan/mapping/entities";
import { buildSystemMap } from "@/lib/platform-scan/mapping/explore";
import { describeIntegrations } from "@/lib/platform-scan/mapping/integrations";
import { assessWalkedTraffic } from "@/lib/platform-scan/mapping/assess";
import { saveWalkedMap } from "@/lib/platform-scan/mapping/store";
import { trackEvent } from "@/lib/analytics";
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
      "        [--sign-in]  open a browser, log in yourself, press Enter\n" +
      "        [--email <user> --login-path /login]  scripted, simple logins only\n\n" +
      "The password is typed at a prompt, or read from MAP_PASSWORD. It is\n" +
      "deliberately not a flag: argv is visible to every process on the machine.\n\n" +
      "--authorised-by is required. This sends traffic to a real system and the\n" +
      "run should say who agreed to it.",
  );
  process.exit(2);
}

(async () => {
  console.log(`\nMapping ${baseUrl}`);
  console.log(`Authorised by: ${authorisedBy}`);
  console.log("Read-only: no form is submitted, and every non-GET request is blocked.\n");

  /* A person cannot sign in to a browser they cannot see. */
  if (process.argv.includes("--sign-in")) process.env.BROWSER_HEADED = "1";

  const handle = await createSpecDiffBrowser();
  try {
    const page = (await handle.browser.newPage()) as unknown as ScanPage;

    const email = arg("email");
    const signInByHand = process.argv.includes("--sign-in");
    let authenticated = false;

    if (signInByHand) {
      /* THE FLOW THAT WORKS EVERYWHERE, because it automates none of it.
       *
       * Cognito's login has no form element: four buttons of type="button"
       * offering Google, Facebook, Microsoft or email, and only after
       * choosing does an email field appear. Three attempts at selectors
       * produced three different failures, none of them about mapping.
       *
       * It also means the password never enters this process, so there is
       * nothing to prompt for and nothing to scrub out of an error. */
      const p = page as unknown as { goto(u: string): Promise<unknown> };
      await p.goto(baseUrl);
      console.log(
        "A browser window is open. Sign in there however you normally would,\n" +
          "including any second factor, and navigate to the page you want mapped.\n",
      );
      await waitForEnter("Press Enter when you are signed in and ready: ");
      authenticated = true;
      console.log("");
    } else if (email) {
      /* Asked for here, not taken from the command line. Typed input persists
         nowhere: not in history, not in argv, not in this repository. */
      const password = await promptSecret(`Password for ${email}: `, {
        envVar: "MAP_PASSWORD",
      });
      if (!password) {
        console.error("No password given, so there is nothing to sign in with.");
        process.exit(2);
      }
      /* BEFORE THE FLOOR. A sign-in is a POST and the floor blocks those, so
         this is the one navigation that happens without it. */
      const loginPath = arg("login-path") ?? "/login";
      const p = page as unknown as {
        goto(u: string): Promise<unknown>;
        fill(sel: string, v: string): Promise<void>;
        click(sel: string): Promise<void>;
        waitForSelector(sel: string, o?: unknown): Promise<unknown>;
        waitForURL(fn: (u: URL) => boolean, o?: unknown): Promise<void>;
      };
      /* EVERY step that touches the password runs inside withSecret, because
         a library reports a failed fill by quoting what it was filling. */
      await withSecret(password, async () => {
        await p.goto(`${baseUrl.replace(/\/$/, "")}${loginPath}`);

        const EMAIL = 'input[type="email"], input[name="email"], input[name="username"]';
        const PASSWORD = 'input[type="password"], input[name="password"]';
        const SUBMIT = 'button[type="submit"], input[type="submit"]';

        await p.fill(EMAIL, email);

        /* A MULTI-STEP SIGN-IN IS THE COMMON CASE, NOT THE EXCEPTION.
           Cognito, Microsoft and Google all ask for the address, then the
           password on a second screen. The field exists in the DOM the whole
           time and is hidden, so filling it immediately times out against
           something that is present and unusable. Wait for it to be usable;
           if it is not, press continue and wait again. */
        const passwordUsable = await p
          .waitForSelector(PASSWORD, { state: "visible", timeout: 4_000 })
          .then(() => true)
          .catch(() => false);

        if (!passwordUsable) {
          await p.click(SUBMIT);
          await p.waitForSelector(PASSWORD, { state: "visible", timeout: 20_000 });
        }

        await p.fill(PASSWORD, password);
        await p.click(SUBMIT);
        await p
          .waitForURL((u: URL) => !u.pathname.includes(loginPath), { timeout: 45_000 })
          .catch(() => undefined);
      });
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
    const { surfaces, coverage, integrations, trafficObserved, trafficTruncated } = await walkSystem(baseUrl, reader, {
      /* --whole-origin for a single-tenant system, where a deep entry URL
         would otherwise confine the map to one folder. */
      confineTo: process.argv.includes("--whole-origin") ? null : (arg("confine-to") ?? undefined),
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

    /* DISTINCT FORMS, AND FURNITURE SEPARATED. Counting instances reported 94
       forms across 40 surfaces on a real tenant, most of them the same support
       widget on every screen. A number that large about a system that small is
       worse than no number, because somebody will quote it. */
    const inv = inventoryForms(surfaces);
    const mutating = inv.content.filter((f) => f.form.mutating);
    console.log(
      `\nWhere data enters: ${inv.content.length} distinct forms ` +
        `(${mutating.length} that would change something)`,
    );
    for (const s of inv.content.slice(0, 12)) {
      const seen = s.surfaces.length > 1 ? `  on ${s.surfaces.length} screens` : "";
      console.log(
        `  ${s.form.mutating ? "writes" : "reads "}  ${s.form.name.slice(0, 42).padEnd(42)} ${s.form.fields.length} fields${seen}`,
      );
    }
    if (inv.chrome.length > 0) {
      /* Reported, not deleted: a support widget that uploads files IS a place
         information leaves an organisation. It just is not the client's. */
      console.log(
        `\nPart of the application frame, on most screens: ${inv.chrome.length}`,
      );
      for (const s of inv.chrome.slice(0, 6)) {
        console.log(`  ${s.form.name.slice(0, 42).padEnd(42)} ${s.form.fields.length} fields`);
      }
    }

    /* WHAT THE SYSTEM MANAGES, AND NOT FROM THE TABLES.
     *
     * This used to print the tables directly, which on the real tenant meant
     * nine rows reading "untitled  1, 2, 3, 4": the application lays its
     * screens out with tables, so every one of them was furniture. Business
     * objects come from the URL structure and the form fields now, both of
     * which are names somebody chose. */
    const entities = inferEntities(surfaces, coverage.patterns);
    console.log(`\nWhat the system manages: ${entities.length} business objects`);
    for (const e of entities.slice(0, 14)) {
      const attrs = e.attributes.length > 0 ? e.attributes.slice(0, 4).join(", ") : "no fields observed";
      console.log(
        `  ${e.name.slice(0, 38).padEnd(38)} ${String(e.evidence.length).padStart(2)} screens  ${attrs.slice(0, 52)}`,
      );
    }

    /* SAMPLED IS NOT THE SAME AS FOUND. Where a shape repeats, the walk opens
       a couple and counts the rest, so the two numbers are printed together:
       a reader can tell a small system from a sample of a large one. */
    const sampled = coverage.patterns.filter((p) => p.visited < p.instances.length);
    if (sampled.length > 0) {
      console.log("\nRepeated screens, sampled rather than walked:");
      for (const p of sampled.slice(0, 8)) {
        console.log(
          `  ${p.shape.slice(0, 44).padEnd(44)} ${String(p.instances.length).padStart(3)} exist, ${p.visited} opened`,
        );
      }
    }

    /* WHERE THE DATA GOES, which is the question a client assessment exists to
       answer. Printed even when nothing was found, because an empty list and
       a scan that was not watching are opposite findings. */
    console.log(`\nWhere data goes: ${describeIntegrations(integrations, trafficObserved)}`);
    for (const i of integrations.slice(0, 10)) {
      const where = i.seenOn.length === 1 ? "1 screen" : `${i.seenOn.length} screens`;
      console.log(
        `  ${(i.vendor ?? "unrecognised").slice(0, 22).padEnd(22)} ${i.host.slice(0, 34).padEnd(34)} ${String(i.requestCount).padStart(4)} requests, ${where}`,
      );
    }
    if (trafficTruncated) {
      console.log("  (recording hit its cap, so this list is a floor rather than a total)");
    }

    /* WHAT NOTHING ACCOUNTS FOR. The same detector the compliance scan uses,
       given a whole system instead of one page. A host contacted only by the
       settings screen has been invisible to it for the life of the product. */
    const assessment = assessWalkedTraffic({
      entryUrl: baseUrl,
      observations: reader.observations?.() ?? [],
      entryHeaders: reader.entryHeaders?.() ?? null,
      trafficObserved,
      trafficTruncated,
      nowIso: new Date().toISOString(),
    });
    const notable = assessment.report.findings.filter((f) => f.severity !== "low");
    if (notable.length > 0) {
      console.log(`\nContacted, and nothing accounts for it: ${notable.length}`);
      for (const f of notable.slice(0, 8)) {
        console.log(`  ${f.severity.padEnd(8)} ${f.host.slice(0, 38).padEnd(38)} ${f.summary.slice(0, 70)}`);
      }
    }
    for (const c of assessment.report.caveats) console.log(`  note: ${c.slice(0, 150)}`);

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
    /* THE MAP OUTLIVES THE TERMINAL IT WAS PRINTED IN.
     *
     * Until now the walk wrote nothing: a scan of a client's system existed
     * for as long as somebody kept the window open. The report's System Map
     * section read from a store nothing had ever written to, so it said "no
     * system profile has been generated" no matter how many systems had
     * actually been walked.
     *
     * Persisted per (workspace, entry point), so re-walking a system replaces
     * its snapshot rather than accumulating stale ones a report might average
     * over. */
    const platform = (() => {
      try {
        return new URL(baseUrl).hostname.replace(/^www\./, "");
      } catch {
        return "unknown";
      }
    })();

    const map = buildSystemMap({
      platform,
      entryUrl: baseUrl,
      surfaces,
      entities,
      integrations,
      coverage,
      now: new Date().toISOString(),
    });

    const workspaceId = arg("workspace") ?? "default";
    if (!process.env.DATABASE_URL) {
      /* Said out loud rather than skipped quietly. A run that printed a map
         and stored nothing, without saying so, is how somebody concludes the
         report is broken a week later. */
      console.log("\nNot stored: DATABASE_URL is not set, so this map exists only above.");
    } else {
      try {
        await saveWalkedMap(workspaceId, map, authorisedBy);
        trackEvent("platform.system_walked", "system", "system", {
          platform,
          surfaces: surfaces.length,
          entities: entities.length,
          forms: inv.content.length,
          /* Travels WITH the counts: a map that stopped early and a map that
             finished look identical once these are separated. */
          frontier_remaining: coverage.frontierRemaining,
          stop_reason: coverage.stopReason,
          sampled_shapes: sampled.length,
        });
        console.log(`\nStored for workspace ${workspaceId}. It will appear in the System Map section of the report.`);
      } catch (err) {
        console.log(`\nNot stored: ${(err as Error).message.slice(0, 120)}`);
      }
    }
  } finally {
    await handle.close();
  }
  process.exit(0);
})().catch((err) => {
  /* THE LAST EXIT, SCRUBBED TOO. withSecret covers the sign-in, and this
     covers everything after it: a redirect URL, a cookie header or a stack
     from deeper in a library can all carry the value, and this is the one
     line that reaches a terminal. */
  const secret = process.env.MAP_PASSWORD ?? "";
  const message = (err as Error).message ?? String(err);
  console.error(`\nmapping failed: ${scrubSecret(message, secret).slice(0, 400)}`);
  process.exit(1);
});
