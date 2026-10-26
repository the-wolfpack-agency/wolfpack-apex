/**
 * Render Forcefield alert email previews to files. NEVER sends anything.
 *
 *   npx tsx scripts/forcefield-alert-preview.ts --out <dir> [--site instinct]
 *       [--since-hours 24] [--at 2026-10-26T14:02:44Z] [--digest]
 *       [--fixture events.json] [--png]
 *
 * Source of the events, in order:
 *   --fixture <file>  a HostileEventGroup[] JSON (offline, no database)
 *   otherwise         the LIVE events (same SQL as the cron), read-only: run with
 *                     PGOPTIONS="-c default_transaction_read_only=on" and an
 *                     unpooled DATABASE_URL so nothing can be written.
 *
 * Default: one preview per IMMEDIATE incident (the emails the cron would send
 * right away): operator.html / operator.txt, plus the client-facing template
 * (tenant.*, NOT sent during the build phase; the preview carries a banner).
 * --digest: a digest over the last --since-hours (default 24, window aligned,
 * including the window in progress), as digest.html / digest.txt, plus a
 * routing summary on stdout.
 * --png screenshots each HTML at 1280 and 390 px wide in Chromium (Playwright).
 */
import "./load-env";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { alertFromIncident, alertRecipientEmails, alertRowId, digestKey, liveForcefieldAlertDeps, windowStartOf, type ForcefieldAlert } from "@/lib/forcefield-web/alerts";
import { renderForcefieldAlertEmail, alertSubject, alertSummary } from "@/lib/forcefield-web/alert-email";
import { buildDigest, buildIncidents, easternParts, type HostileEventGroup } from "@/lib/forcefield-web/incidents";
import { instinctPublicBaseUrl } from "@/lib/mail/public-base-url";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const BUILD_PHASE_BANNER =
  `<div style="background:#7a2e0e;color:#fff;font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;font-weight:700;padding:10px 16px;text-align:center;">` +
  `PREVIEW ONLY: client-facing template, not sent (build phase)</div>`;

async function loadEvents(since: string, until: string): Promise<HostileEventGroup[]> {
  const fixture = arg("fixture");
  if (fixture) return JSON.parse(readFileSync(resolve(fixture), "utf-8")) as HostileEventGroup[];
  if (!/default_transaction_read_only\s*=\s*on/.test(process.env.PGOPTIONS ?? "")) {
    throw new Error('Refusing a live read without PGOPTIONS="-c default_transaction_read_only=on"');
  }
  return liveForcefieldAlertDeps().listHostileEvents(since, until);
}

async function main(): Promise<void> {
  const out = resolve(arg("out") ?? "ff-email-preview");
  mkdirSync(out, { recursive: true });
  const now = new Date();
  const hours = Number(arg("since-hours") ?? 24);
  const since = windowStartOf(new Date(now.getTime() - hours * 3600_000));
  const site = arg("site");
  const groups = (await loadEvents(since, now.toISOString())).filter((g) => !site || g.site === site);
  const incidents = buildIncidents(groups);
  const base = instinctPublicBaseUrl();
  const htmlFiles: string[] = [];

  if (flag("digest")) {
    // A preview covers the whole lookback INCLUDING the window in progress (the
    // live digest only covers ended windows, so these would land in the next one).
    const end = new Date(Date.parse(windowStartOf(now)) + 6 * 3600_000);
    const digest = buildDigest(incidents, { etDate: easternParts(now).date, start: new Date(since), end });
    console.log(`Routing over ${since} .. ${end.toISOString()}: ${incidents.length} incidents, ${incidents.filter((i) => i.route === "immediate").length} immediate, ${digest.totals.incidents} digest`);
    if (digest.totals.incidents === 0) {
      console.log("Nothing to report: the digest would be skipped.");
      return;
    }
    const alert: ForcefieldAlert = { kind: "alert_digest", dedupeKey: digestKey(digest.etDate), title: "", body: "", windowStart: digest.periodEnd, digest };
    alert.title = alertSubject(alert);
    alert.body = alertSummary(alert);
    const mail = renderForcefieldAlertEmail(alert, { audience: "operator", baseUrl: base, recipients: alertRecipientEmails(), alertId: alertRowId(alert) });
    writeFileSync(join(out, "digest.html"), mail.html);
    writeFileSync(join(out, "digest.txt"), `Subject: ${mail.subject}\n\n${mail.text}\n`);
    htmlFiles.push(join(out, "digest.html"));
    console.log(`${mail.subject}\n  -> ${join(out, "digest.html")}`);
  } else {
    const at = arg("at") ? new Date(arg("at") as string).getTime() : null;
    const covers = (firstAt: string, lastAt: string) => at === null || (new Date(firstAt).getTime() <= at && at <= new Date(lastAt).getTime() + 999);
    const immediate = incidents.filter((i) => i.route === "immediate" && covers(i.detail.firstAt, i.detail.lastAt));
    if (immediate.length === 0) {
      console.log("No matching immediate incident.");
      return;
    }
    const deps = liveForcefieldAlertDeps();
    for (const [n, inc] of immediate.entries()) {
      let alert = alertFromIncident(inc);
      if (!arg("fixture") && deps.enrich) alert = await deps.enrich(alert);
      const prefix = immediate.length > 1 ? `${n + 1}-` : "";
      const op = renderForcefieldAlertEmail(alert, { audience: "operator", baseUrl: base, recipients: alertRecipientEmails(), alertId: alertRowId(alert) });
      const tn = renderForcefieldAlertEmail(alert, { audience: "tenant", baseUrl: base, recipients: ["security@client.example"] });
      writeFileSync(join(out, `${prefix}operator.html`), op.html);
      writeFileSync(join(out, `${prefix}operator.txt`), `Subject: ${op.subject}\n\n${op.text}\n`);
      writeFileSync(join(out, `${prefix}tenant.html`), tn.html.replace(/<body([^>]*)>/, `<body$1>${BUILD_PHASE_BANNER}`));
      writeFileSync(join(out, `${prefix}tenant.txt`), `PREVIEW ONLY: not sent (build phase)\nSubject: ${tn.subject}\n\n${tn.text}\n`);
      htmlFiles.push(join(out, `${prefix}operator.html`), join(out, `${prefix}tenant.html`));
      console.log(`${op.subject}\n  -> ${join(out, `${prefix}operator.html`)}`);
    }
  }
  if (flag("png")) {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      for (const file of htmlFiles) {
        for (const width of [1280, 390]) {
          const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: width < 500 ? 2 : 1 });
          await page.goto(`file://${file}`);
          const png = file.replace(/\.html$/, `-${width === 1280 ? "desktop-1280" : "mobile-390"}.png`);
          await page.screenshot({ path: png, fullPage: true });
          await page.close();
          console.log(`  png ${png}`);
        }
      }
    } finally {
      await browser.close();
    }
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error((err as Error).message);
    process.exit(1);
  },
);
