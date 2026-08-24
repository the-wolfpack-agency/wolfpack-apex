/**
 * Drive the explorer against a real, authenticated system.
 *
 * The mapping logic shipped as pure functions with 35 tests and no
 * caller: it decides where to look next, what to refuse, and what a map
 * may claim, and nothing has ever walked anything with it. Everything it
 * knows has been proved against fixtures.
 *
 * This is the driver. It signs in with a real browser, walks what it
 * finds using those rules and nothing else, and prints the map.
 *
 * WHY OUR OWN APP IS A FAIR TEST. The reason the profile pipeline could
 * not do this job is that a client's Salesforce has no migrations, no
 * manifest, no sitemap, and a navigation tree that exists only after
 * login once the JavaScript has run. An authenticated Instinct is the
 * same shape: same absence of artefacts, same client-rendered nav, same
 * need to be a polite guest. If the rules hold here they are worth
 * pointing at somebody else's instance; if they do not, we find out on
 * our own system rather than on theirs.
 *
 * WHAT IT WILL NOT DO. It never submits a form, never follows anything
 * the danger check refuses, and never leaves the origin it started on.
 * Those decisions are the explorer's, not this file's: the driver's only
 * job is to fetch what it is told to fetch and report what it saw.
 *
 * Usage:
 *   WALK_URL=... WALK_EMAIL=... WALK_PASSWORD=... npx tsx scripts/walk-a-system.ts
 */

import { chromium, type Page } from "@playwright/test";
import {
  DEFAULT_BUDGET,
  Frontier,
  budgetExceeded,
  buildSystemMap,
  describeCoverage,
  shouldFollow,
  signatureOf,
} from "@/lib/platform-scan/mapping/explore";
import type { MappedSurface, StopReason } from "@/lib/platform-scan/mapping/types";

/** Smaller than the default: a proof should be quick and polite. */
const BUDGET = { ...DEFAULT_BUDGET, maxSurfaces: 25, maxDepth: 3, maxDurationMs: 120_000 };

/** Everything a surface is, read from a page that has finished rendering. */
async function observe(page: Page, url: string, depth: number, status: number | null, loadMs: number): Promise<MappedSurface> {
  /* Passed as a STRING rather than a function.
     tsx compiles with esbuild's keep-names on, which wraps every named
     function in a __name() helper. Playwright serialises the function
     into the page, the helper does not exist there, and every evaluate
     dies with "__name is not defined". A string is compiled by the
     browser and never touched by the bundler. */
  const seen = (await page.evaluate(`(() => {
    const text = function (el) { return ((el && el.textContent) || "").replace(/\\s+/g, " ").trim(); };
    return {
      title: document.title || null,
      headings: Array.prototype.slice.call(document.querySelectorAll("h1, h2"))
        .map(text).filter(function (t) { return t.length > 0 && t.length < 120; }).slice(0, 12),
      forms: Array.prototype.slice.call(document.querySelectorAll("form")).slice(0, 10).map(function (f) {
        return {
          name: f.getAttribute("name") || f.getAttribute("id") || text(f.querySelector("legend, h1, h2, label") || f).slice(0, 60) || "form",
          method: (f.getAttribute("method") || "get").toLowerCase(),
          fields: Array.prototype.slice.call(f.querySelectorAll("input, select, textarea")).map(function (i) {
            return {
              name: i.getAttribute("name") || i.getAttribute("id") || "",
              type: i.getAttribute("type") || i.tagName.toLowerCase(),
              required: i.hasAttribute("required"),
            };
          }).filter(function (x) { return x.name; }).slice(0, 25),
          mutating: (f.getAttribute("method") || "get").toLowerCase() !== "get" ||
            /(create|save|submit|delete|remove|update|send)/i.test(text(f)),
        };
      }),
      tables: Array.prototype.slice.call(document.querySelectorAll("table")).slice(0, 8).map(function (t) {
        return {
          caption: text(t.querySelector("caption") || t.querySelector("thead th") || t).slice(0, 60) || null,
          columns: Array.prototype.slice.call(t.querySelectorAll("thead th")).map(text).filter(Boolean).slice(0, 20),
          rowCount: t.querySelectorAll("tbody tr").length,
        };
      }),
    };
  })()`)) as {
    title: string | null;
    headings: string[];
    forms: unknown[];
    tables: { caption: string | null; columns: string[]; rowCount: number }[];
  };

  return {
    url,
    signature: signatureOf(url),
    title: seen.title,
    depth,
    headings: seen.headings,
    /* Filled by the caller once the links have been through shouldFollow:
       a surface records where it CAN lead, and the walk decides where it
       actually goes. */
    linksTo: [],
    forms: seen.forms as unknown as MappedSurface["forms"],
    tables: seen.tables,
    status,
    loadMs: Math.round(loadMs),
  };
}

async function main(): Promise<void> {
  const entryUrl = process.env.WALK_URL;
  const email = process.env.WALK_EMAIL;
  const password = process.env.WALK_PASSWORD;
  if (!entryUrl || !email || !password) {
    console.error("WALK_URL, WALK_EMAIL and WALK_PASSWORD are required.");
    process.exitCode = 1;
    return;
  }
  const origin = new URL(entryUrl).origin;

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  /* Sign in the way a person does. A token minted out of band would test
     a system nobody uses: the nav tree this walk depends on is rendered
     for a signed-in session and for nothing else. */
  const loginStarted = Date.now();
  const res = await page.request.post(`${origin}/api/auth/login`, {
    data: { email, password },
  });
  if (!res.ok()) {
    console.error(`login failed: ${res.status()}`);
    await browser.close();
    process.exitCode = 1;
    return;
  }
  const body = (await res.json()) as { accessToken?: string; token?: string };
  const token = body.accessToken ?? body.token;
  /* The key the client actually reads. Guessing it produced a walk that
     signed in successfully and then browsed as a logged-OUT visitor,
     which mapped one 404 and reported the system fully explored. */
  const me = (await (await page.request.get(`${origin}/api/auth/whoami`, {
    headers: { authorization: `Bearer ${token ?? ""}` },
  })).json().catch(() => ({}))) as { user?: unknown };
  await page.addInitScript(
    ([t, u]) => {
      window.localStorage.setItem("instinct_token", t);
      if (u) window.localStorage.setItem("instinct_user", u);
    },
    [token ?? "", me?.user ? JSON.stringify(me.user) : ""] as [string, string],
  );
  console.log(`signed in as ${email} in ${Date.now() - loginStarted}ms\n`);

  const seen = new Set<string>();
  const frontier = new Frontier(seen);
  const skipped: { signature: string; reason: string }[] = [];
  const surfaces: MappedSurface[] = [];
  const startedAt = Date.now();
  let maxDepthReached = 0;
  let stopReason: StopReason = "frontier-exhausted";

  frontier.add(entryUrl, 0);

  for (;;) {
    const over = budgetExceeded(
      { surfaces: surfaces.length, depth: maxDepthReached, elapsedMs: Date.now() - startedAt },
      BUDGET,
    );
    if (over) {
      stopReason = over;
      break;
    }
    const item = frontier.next();
    if (!item) break;

    const sig = signatureOf(item.url);
    if (seen.has(sig)) continue;
    seen.add(sig);

    const t0 = Date.now();
    let status: number | null = null;
    try {
      const resp = await page.goto(item.url, { waitUntil: "networkidle", timeout: 20_000 });
      status = resp?.status() ?? null;
    } catch {
      /* A surface that will not load is still a fact about the system,
         recorded with a null status rather than dropped. */
    }
    const loadMs = Date.now() - t0;
    const surface = await observe(page, item.url, item.depth, status, loadMs);
    maxDepthReached = Math.max(maxDepthReached, item.depth);

    const links = (await page.evaluate(
      `Array.prototype.slice.call(document.querySelectorAll("a[href]")).map(function (a) { return a.href; })`,
    )) as string[];
    const onward = new Set<string>();
    for (const href of links) {
      const verdict = shouldFollow(href, {
        origin,
        seen,
        depth: item.depth,
        maxDepth: BUDGET.maxDepth,
      });
      if (verdict.follow) {
        onward.add(signatureOf(href));
        frontier.add(href, item.depth + 1);
      } else if (verdict.reason !== "already-seen") {
        skipped.push({ signature: signatureOf(href), reason: verdict.reason });
      }
    }
    surface.linksTo = [...onward];
    surfaces.push(surface);

    /* The heading names the screen, not the title. Walking our own app
       found every one of 25 surfaces titled "OGIAM Instinct", because the
       app sets no per-page title: a real finding about the system, and a
       reason a map must never depend on titles alone. */
    const names = surface.headings[0] ?? surface.title ?? "(unnamed)";
    console.log(
      `  d${item.depth} ${String(status ?? "err").padEnd(4)} ${String(loadMs).padStart(5)}ms  ` +
        `${names}`.slice(0, 90),
    );
  }

  const map = buildSystemMap({
    platform: "instinct",
    entryUrl,
    surfaces,
    entities: [],
    integrations: [],
    coverage: {
      surfacesReached: surfaces.length,
      frontierRemaining: frontier.size,
      /* Deduped: fifty links to the same logout is one decision, and a
         list that repeats it fifty times hides the other reasons. */
      skipped: [...new Map(skipped.map((s) => [`${s.signature}:${s.reason}`, s])).values()],
      maxDepthReached,
      stopReason,
      durationMs: Date.now() - startedAt,
    },
    now: new Date(startedAt).toISOString(),
  });

  /* AN ENTRY POINT THAT DID NOT LOAD IS NOT A MAPPED SYSTEM.
     Walking a 404 produced one surface, no links, and the sentence
     "every screen reachable by following links from the entry point was
     visited", which is true and completely misleading. The coverage
     description cannot know this; the driver can. */
  const entry = map.surfaces[0];
  if (!entry || entry.status === null || entry.status >= 400) {
    console.log(
      `\nThe entry point returned ${entry?.status ?? "no response"}. Nothing was mapped: ` +
        `what follows describes a failed walk, not a small system.`,
    );
    process.exitCode = 1;
    await browser.close();
    return;
  }

  console.log(`\n${describeCoverage(map.coverage, map.platform)}`);
  console.log(`\nsurfaces: ${map.surfaces.length}   paths derived: ${map.paths.length}`);
  const verified = map.paths.filter((p) => p.verified).length;
  console.log(`paths verified end to end: ${verified} of ${map.paths.length}`);

  const withForms = map.surfaces.filter((s) => s.forms.length > 0);
  const withTables = map.surfaces.filter((s) => s.tables.length > 0);
  console.log(`surfaces with a form: ${withForms.length}   with a table: ${withTables.length}`);

  const reasons = new Map<string, number>();
  for (const s of map.coverage.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
  console.log(
    `refused: ${[...reasons.entries()].map(([r, n]) => `${r} ${n}`).join(", ") || "nothing"}`,
  );

  /* Unnamed screens are a finding in their own right. On somebody else's
     system it means the map cannot describe what it found; on ours it
     means every browser tab says the same thing. */
  const named = new Set(map.surfaces.map((x) => x.headings[0] ?? x.title ?? ""));
  if (named.size <= 2 && map.surfaces.length > 5) {
    console.log(
      `\nWARNING: ${map.surfaces.length} surfaces share ${named.size} distinct name(s). ` +
        `The system does not name its own screens, so this map is structural only.`,
    );
  }

  /* Titles and headings are different facts and only one of them was
     useful here: all 25 surfaces carry the same <title>, so a map built
     on titles would have said the system has one screen. */
  const titles = new Set(map.surfaces.map((x) => x.title ?? ""));
  if (titles.size <= 2 && map.surfaces.length > 5) {
    console.log(
      `\nNote: ${map.surfaces.length} surfaces share ${titles.size} distinct <title>. ` +
        `Screens are named below by their heading instead, which is what a person reads.`,
    );
  }

  console.log(`\nwhat the screens are called:`);
  for (const s2 of map.surfaces.slice(0, 12)) {
    console.log(`  ${(s2.headings[0] ?? s2.title ?? "(unnamed)").slice(0, 60).padEnd(62)}${s2.signature}`);
  }

  const slowest = [...map.surfaces].sort((a, b) => (b.loadMs ?? 0) - (a.loadMs ?? 0)).slice(0, 3);
  console.log(`\nslowest surfaces (a slow screen IS a finding):`);
  for (const s2 of slowest) {
    console.log(`  ${String(s2.loadMs).padStart(5)}ms  ${s2.headings[0] ?? s2.title ?? s2.url}`);
  }

  await browser.close();
}

void main();
