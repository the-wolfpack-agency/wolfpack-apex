/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";

/**
 * Connect the SharePoint sites we can reach and have no source for.
 *
 * WHAT THIS IS FOR. On a client deployment they hand over access to a set of
 * libraries and expect the product to use them. Measured on our own tenant on
 * 2026-09-02: nineteen sites reachable, sources for two, and one of those two
 * pointed three folders deep so a whole site contributed ten documents. Every
 * answer was confident and drawn from a fraction of what we had been given,
 * and there was no way to tell from the outside.
 *
 * Doing that by hand means pasting a folder URL per library and remembering to.
 * This reads what the connected accounts can actually open and offers the gap.
 *
 * SCOPE IS A DECISION, NOT A DEFAULT. `--include` is required, because a
 * tenant holds more than one client's material and indexing all of it into one
 * library would put another client's documents behind answers about this one.
 * There is no "everything" flag for that reason.
 *
 * DRY RUN unless --apply. It prints exactly which sites it would connect and
 * how many files each was seen to hold.
 *
 * IT NEVER TOUCHES AN EXISTING SOURCE. It only adds sites nothing points at.
 * Editing or removing what somebody configured is a separate, deliberate act.
 *
 *   npx tsx scripts/connect-sharepoint-sites.ts --include 'ford' --estate ford
 *   npx tsx scripts/connect-sharepoint-sites.ts --include 'ford' --estate ford --apply
 *
 * --estate says whose material this is, and is required for the same reason
 * --include is: the client-facing pages filter on it, so a site connected under
 * the wrong estate silently joins another client's reported library.
 */

import { Client } from "pg";
import { siteOf } from "@/lib/connectors/sharepoint/coverage";

/** Graph returns at most 200 hits per request; three pages is a decent floor. */
const PAGES = 3;
const PAGE_SIZE = 200;

interface Discovered {
  site: string;
  siteId: string;
  driveId: string;
  filesSeen: number;
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

async function search(token: string, from: number): Promise<unknown[]> {
  const res = await fetch("https://graph.microsoft.com/v1.0/search/query", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        {
          /* driveItem alone. The other entity types need Sites.Read.All, and
             Graph fails the WHOLE request when the token cannot cover every
             type asked for. */
          entityTypes: ["driveItem"],
          query: { queryString: "*" },
          from,
          size: PAGE_SIZE,
        },
      ],
    }),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as {
    value?: Array<{ hitsContainers?: Array<{ hits?: unknown[] }> }>;
  };
  return body.value?.[0]?.hitsContainers?.[0]?.hits ?? [];
}

async function main(): Promise<void> {
  const include = arg("include");
  const estate = arg("estate");
  const apply = process.argv.includes("--apply");
  if (!include) {
    console.error(
      "--include <regex> is required. A tenant holds more than one client's material,\n" +
        "and indexing all of it into one library puts another client's documents behind\n" +
        "answers about this one. Name the estate you mean, for example:\n" +
        "  --include 'pcna|porsche|wolfpack'",
    );
    process.exit(2);
  }
  if (!estate) {
    console.error(
      "--estate <name> is required. The Phase 1 page and every other client-facing\n" +
        "figure filters on it, so a site connected under the wrong estate joins\n" +
        "another client's reported library without anybody seeing it happen.",
    );
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(2);
  }
  const scope = new RegExp(include, "i");

  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await db.connect();

  try {
    const { rows: accounts } = await db.query<{ user_email: string; access_token: string }>(
      `SELECT user_email, access_token FROM instinct_ms_tokens
        WHERE expires_at > now() ORDER BY updated_at DESC`,
    );
    if (accounts.length === 0) {
      /* REFUSED, not "nothing to connect". With no live token the reachable set
         is empty for a reason that has nothing to do with what exists, and
         reporting a clean run here would say "you are connected to everything"
         on the day the connection broke. */
      console.error("No account holds a live Microsoft token, so nothing can be discovered.");
      console.error("This is not the same as having nothing to connect. Reconnect Microsoft first.");
      process.exit(1);
    }

    const found = new Map<string, Discovered>();
    for (const account of accounts) {
      for (let page = 0; page < PAGES; page++) {
        const hits = await search(account.access_token, page * PAGE_SIZE);
        if (hits.length === 0) break;
        for (const raw of hits) {
          const h = raw as {
            resource?: { webUrl?: string; parentReference?: { siteId?: string; driveId?: string } };
          };
          const site = siteOf(h.resource?.webUrl);
          const siteId = h.resource?.parentReference?.siteId;
          const driveId = h.resource?.parentReference?.driveId;
          if (!site || !siteId || !driveId) continue;
          const existing = found.get(site);
          if (existing) existing.filesSeen += 1;
          else found.set(site, { site, siteId, driveId, filesSeen: 1 });
        }
      }
    }

    const { rows: sources } = await db.query<{ site_url: string }>(
      `SELECT site_url FROM instinct_sharepoint_sources WHERE workspace_id = 'default'`,
    );
    const connected = new Set(sources.map((s) => siteOf(s.site_url)).filter(Boolean) as string[]);

    const all = [...found.values()].sort((a, b) => b.filesSeen - a.filesSeen);
    const missing = all.filter((s) => !connected.has(s.site));
    const inScope = missing.filter((s) => scope.test(s.site));
    const outOfScope = missing.filter((s) => !scope.test(s.site));

    console.log(`${all.length} site(s) reachable, ${connected.size} already connected`);
    console.log(`\n${inScope.length} to connect as estate "${estate}" (matching /${include}/i):`);
    for (const s of inScope) console.log(`  ${String(s.filesSeen).padStart(4)}+ files  ${s.site}`);
    if (outOfScope.length) {
      console.log(`\n${outOfScope.length} reachable and NOT connected, outside that scope:`);
      for (const s of outOfScope) console.log(`  ${String(s.filesSeen).padStart(4)}+ files  ${s.site}`);
      console.log("  Widen --include if these belong in this library.");
    }

    if (!apply) {
      console.log("\nDRY RUN. Nothing written. Re-run with --apply.");
      return;
    }

    for (const s of inScope) {
      /* folder_path '' is the library root, which is the point: a source three
         folders down is how a whole site came to contribute ten documents.
         audience_roles matches the default the table already carries. */
      const name = decodeURIComponent(s.site.split("/sites/")[1] ?? s.site);
      await db.query(
        `INSERT INTO instinct_sharepoint_sources
           (workspace_id, name, site_url, site_id, drive_id, folder_path, created_by, is_active, estate)
         VALUES ('default', $1, $2, $3, $4, '', 'connect-sharepoint-sites', true, $5)`,
        [name, s.site, s.siteId, s.driveId, estate],
      );
      console.log(`connected ${name} to estate "${estate}"`);
    }
    console.log(`\nConnected ${inScope.length} site(s) at library root. Run a sync to index them.`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  const e = err as Error & { code?: string; detail?: string };
  console.error("failed:", e.message || "(no message)", e.code ?? "", e.detail ?? "");
  process.exit(1);
});
