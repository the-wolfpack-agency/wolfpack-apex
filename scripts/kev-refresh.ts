/**
 * scripts/kev-refresh.ts - refresh the bundled CISA KEV snapshot.
 *
 *   npm run kev:refresh                 # fetch the live feed, rewrite the snapshot
 *   npm run kev:check                   # fetch the live feed, exit 1 on drift
 *   npx tsx scripts/kev-refresh.ts --from <feed.json> [--check]   # offline
 *
 * The tracked CVE set is NOT typed here: it is the union of the ids the code
 * references (Forcefield CVE probe rules + the platform-scan edge-device map), so
 * adding a rule that names a new CVE makes `kev:check` fail until the snapshot is
 * refreshed. A tracked id absent from the live feed is an error: the snapshot is
 * never written with a CVE CISA does not list.
 *
 * Output is deterministic (sorted, fixed layout). `--check` compares the tracked
 * entries only, not the catalog version, so a routine CISA addition elsewhere in
 * the catalog does not fail it. It prints CVE ids only (public catalog ids the
 * code already names), never targets or findings.
 */
import fs from "fs";
import path from "path";
import { buildSnapshot, diffEntries, parseKevFeed, renderSnapshotFile, KEV_FEED_URL } from "../src/lib/forcefield/kev/refresh";
import { KEV_SNAPSHOT } from "../src/lib/forcefield/kev/catalog.generated";
import { FORCEFIELD_KEV_CVES } from "../src/lib/forcefield-web/kev-rules";
import { EDGE_EXPOSURE_KEV_CVES } from "../src/lib/platform-scan/edge-exposure/kev-snapshot";

const OUT = path.resolve(__dirname, "../src/lib/forcefield/kev/catalog.generated.ts");
const FETCH_TIMEOUT_MS = 60_000;

async function loadFeed(from: string | null): Promise<unknown> {
  if (from) return JSON.parse(fs.readFileSync(from, "utf8"));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(KEV_FEED_URL, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`KEV feed returned HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const fromIdx = args.indexOf("--from");
  const from = fromIdx >= 0 ? args[fromIdx + 1] ?? null : null;

  const parsed = parseKevFeed(await loadFeed(from));
  if (!parsed.ok) {
    console.error(`kev: invalid feed: ${parsed.error}`);
    return 2;
  }
  const tracked = [...FORCEFIELD_KEV_CVES, ...EDGE_EXPOSURE_KEV_CVES];
  const built = buildSnapshot(parsed.feed, tracked);
  if (!built.ok) {
    console.error(`kev: ${built.error}`);
    return 1;
  }

  if (check) {
    const drift = diffEntries(KEV_SNAPSHOT.entries, built.snapshot.entries);
    console.log(`kev: live catalog ${parsed.feed.catalogVersion}, snapshot ${KEV_SNAPSHOT.catalogVersion || "(none)"}, tracked ${Object.keys(built.snapshot.entries).length}`);
    if (drift.length > 0) {
      console.error(`kev: DRIFT in ${drift.length} tracked entr${drift.length === 1 ? "y" : "ies"}: ${drift.join(", ")}`);
      console.error("kev: run `npm run kev:refresh`, review the diff, commit.");
      return 1;
    }
    console.log("kev: no drift");
    return 0;
  }

  fs.writeFileSync(OUT, renderSnapshotFile(built.snapshot));
  console.log(`kev: wrote ${Object.keys(built.snapshot.entries).length} entries from catalog ${parsed.feed.catalogVersion}`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`kev: ${(err as Error).message}`);
    process.exit(2);
  },
);
