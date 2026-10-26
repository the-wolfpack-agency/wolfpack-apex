/**
 * Render Forcefield alert email previews to files. NEVER sends anything.
 *
 *   npx tsx scripts/forcefield-alert-preview.ts --out <dir> [--site ogiam.com]
 *       [--since-hours 24] [--path /_ff/records] [--kind honeytoken_trip]
 *       [--at 2026-10-26T10:05:37Z] [--fixture incident.json] [--png]
 *
 * Source of the incident, in order:
 *   --fixture <file>  a HostileSignal JSON (offline, no database)
 *   otherwise         the LIVE incident scan (same SQL as the cron), read-only:
 *                     run with PGOPTIONS="-c default_transaction_read_only=on"
 *                     and an unpooled DATABASE_URL so nothing can be written.
 *
 * Writes, per incident: operator.html / operator.txt (the email Wolfpack gets)
 * and tenant.html / tenant.txt (the client-facing template, which is NOT sent
 * during the build phase; the preview carries a banner saying so). With --png it
 * screenshots each HTML at 1280 and 390 px wide in Chromium (Playwright).
 */
import "./load-env";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { alertFromSignal, alertRecipientEmails, alertRowId, liveForcefieldAlertDeps, type HostileSignal } from "@/lib/forcefield-web/alerts";
import { renderForcefieldAlertEmail } from "@/lib/forcefield-web/alert-email";
import { instinctPublicBaseUrl } from "@/lib/mail/public-base-url";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const BUILD_PHASE_BANNER =
  `<div style="background:#7a2e0e;color:#fff;font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;font-weight:700;padding:10px 16px;text-align:center;">` +
  `PREVIEW ONLY: client-facing template, not sent (build phase)</div>`;

async function loadSignals(): Promise<HostileSignal[]> {
  const fixture = arg("fixture");
  if (fixture) {
    const raw = JSON.parse(readFileSync(resolve(fixture), "utf-8")) as HostileSignal | HostileSignal[];
    return Array.isArray(raw) ? raw : [raw];
  }
  if (!/default_transaction_read_only\s*=\s*on/.test(process.env.PGOPTIONS ?? "")) {
    throw new Error('Refusing a live read without PGOPTIONS="-c default_transaction_read_only=on"');
  }
  return liveForcefieldAlertDeps().listHostileSignals(Number(arg("since-hours") ?? 24));
}

async function main(): Promise<void> {
  const out = resolve(arg("out") ?? "ff-email-preview");
  mkdirSync(out, { recursive: true });
  const site = arg("site");
  const path = arg("path");
  const kind = arg("kind");
  // --at: only the incident whose first..last event range contains this time.
  const at = arg("at") ? new Date(arg("at") as string).getTime() : null;
  const covers = (s: HostileSignal) => at === null || (!!s.detail && Math.floor(new Date(s.detail.firstAt).getTime() / 1000) <= Math.floor(at / 1000) && Math.floor(at / 1000) <= Math.floor(new Date(s.detail.lastAt).getTime() / 1000));
  const deps = liveForcefieldAlertDeps();
  const signals = (await loadSignals()).filter((s) =>
    (!site || s.site === site) && (!kind || s.kind === kind) && covers(s) && (!path || (s.detail?.paths ?? [s.samplePath]).includes(path)));
  if (signals.length === 0) {
    console.log("No matching incident.");
    return;
  }
  const htmlFiles: string[] = [];
  for (const [n, s] of signals.entries()) {
    let alert = alertFromSignal(s);
    if (!arg("fixture") && deps.enrich) alert = await deps.enrich(alert);
    const prefix = signals.length > 1 ? `${n + 1}-` : "";
    const base = instinctPublicBaseUrl();
    const op = renderForcefieldAlertEmail(alert, { audience: "operator", baseUrl: base, recipients: alertRecipientEmails(), alertId: alertRowId(alert) });
    const tn = renderForcefieldAlertEmail(alert, { audience: "tenant", baseUrl: base, recipients: ["security@client.example"] });
    writeFileSync(join(out, `${prefix}operator.html`), op.html);
    writeFileSync(join(out, `${prefix}operator.txt`), `Subject: ${op.subject}\n\n${op.text}\n`);
    writeFileSync(join(out, `${prefix}tenant.html`), tn.html.replace(/<body([^>]*)>/, `<body$1>${BUILD_PHASE_BANNER}`));
    writeFileSync(join(out, `${prefix}tenant.txt`), `PREVIEW ONLY: not sent (build phase)\nSubject: ${tn.subject}\n\n${tn.text}\n`);
    htmlFiles.push(join(out, `${prefix}operator.html`), join(out, `${prefix}tenant.html`));
    console.log(`${op.subject}\n  -> ${join(out, `${prefix}operator.html`)}`);
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
