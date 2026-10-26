/**
 * scripts/encrypt-graph-tokens.ts - re-seal legacy plaintext Microsoft Graph
 * tokens in instinct_ms_tokens. DRY-RUN BY DEFAULT.
 *
 *   npx tsx scripts/encrypt-graph-tokens.ts            # dry run: report only
 *   npx tsx scripts/encrypt-graph-tokens.ts --apply    # write sealed values
 *
 * The app already re-seals a legacy row on its next read (getValidToken), so
 * this is only needed for rows nobody reads. It is a script and not a
 * migration because sealing needs the application key, and migrations run
 * where that key may not be.
 *
 * SAFETY
 *   - Refuses to write unless the key in this shell opens a value the app has
 *     ALREADY sealed (a connector credential or a sealed Graph token). Sealing
 *     under the wrong key would make every token unreadable to the app.
 *     `vercel env pull` redacts sensitive values; a redacted key is refused.
 *   - When this shell has a primary key (INSTINCT_SECRET_KEY), also refuses
 *     unless the deployed app is proven to use that same key id (proveAppKey:
 *     a stored value under it, or the app's security.secret_key_primary_active
 *     event). Sealed samples that open under the legacy key alone do not prove
 *     the shell's primary is the app's.
 *   - Each UPDATE is conditional on the row still holding the exact plaintext
 *     read, so a concurrent refresh by the app is never overwritten.
 *   - Prints counts and user ids only. Never prints a token.
 *   - Records security.graph_token_encrypted (source=operator_script) per row.
 */
import "./load-env";
import { Client } from "pg";
import { checkKey, planBackfill, type StoredTokenRow } from "../src/lib/crypto/graph-token-backfill";
import { checkRotationKey, proveAppKey } from "../src/lib/crypto/secret-key-rotation";
import { allowLegacyKeyForBackfill, setSecretKeySignalSink } from "../src/lib/crypto/secret-storage";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  /* This process is not the app: its keyring must never report itself as the
     deployment, or proveAppKey would accept the shell's own report. */
  setSecretKeySignalSink(() => {});
  allowLegacyKeyForBackfill(); // the app no longer opens legacy values once a primary is set; this backfill must
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const db = new Client({ connectionString: url, ssl: url.includes("localhost") || url.includes("127.0.0.1") ? undefined : { rejectUnauthorized: false } });
  await db.connect();
  try {
    if (!apply) await db.query("SET default_transaction_read_only = on");

    const { rows } = await db.query<StoredTokenRow>(
      `SELECT connected_by, user_email, access_token, refresh_token FROM instinct_ms_tokens ORDER BY updated_at DESC`,
    );
    const samples: string[] = rows.flatMap((r) => [r.access_token, r.refresh_token]);
    try {
      const cred = await db.query<{ v: string }>(
        `SELECT auth_header_enc AS v FROM instinct_connector_credentials WHERE auth_header_enc IS NOT NULL LIMIT 5`,
      );
      samples.push(...cred.rows.map((r) => r.v));
    } catch {
      /* table absent in this environment: rely on sealed Graph tokens alone */
    }

    const sampleCheck = checkKey(process.env, samples);
    let key: typeof sampleCheck | { ok: false; reason: "app_key_not_observed" | "app_reports_different_key" } = sampleCheck;
    const primary = checkRotationKey(process.env);
    if (sampleCheck.ok && primary.ok) {
      const proof = await proveAppKey(db, primary.primaryKid);
      if (!proof.ok) key = proof;
    }
    const plan = planBackfill(rows);
    console.log(`[encrypt-graph-tokens] rows=${plan.total} already_sealed=${plan.alreadySealed} to_seal=${plan.updates.length} unreadable=${plan.unreadable.length}`);
    if (plan.unreadable.length > 0) console.log(`  unreadable (sealed but not openable with this key): ${plan.unreadable.join(", ")}`);
    console.log(`[encrypt-graph-tokens] key check: ${key.ok ? `ok (verified against ${key.verifiedAgainst} sealed value(s))` : `REFUSED (${key.reason})`}`);

    if (!apply) {
      console.log("[encrypt-graph-tokens] dry run: nothing written. Re-run with --apply to seal.");
      return;
    }
    if (!key.ok) {
      console.error("[encrypt-graph-tokens] refusing to write: this shell's key is not proven to be the app's key.");
      process.exit(2);
    }

    let written = 0;
    for (const u of plan.updates) {
      const res = await db.query(
        `UPDATE instinct_ms_tokens
            SET access_token = $1, refresh_token = $2, updated_at = NOW()
          WHERE connected_by = $3 AND access_token = $4 AND refresh_token = $5`,
        [u.sealed_access_token, u.sealed_refresh_token, u.connected_by, u.prev_access_token, u.prev_refresh_token],
      );
      if ((res.rowCount ?? 0) > 0) {
        written++;
        const ts = new Date().toISOString();
        await db.query(
          `INSERT INTO instinct_events (event_type, user_id, user_role, metadata, timestamp) VALUES ($1, $2, $3, $4, $5)`,
          ["security.graph_token_encrypted", u.connected_by, "system", JSON.stringify({ user_email: u.user_email, source: "operator_script", ts }), ts],
        );
      }
    }
    console.log(`[encrypt-graph-tokens] sealed ${written} of ${plan.updates.length} planned row(s).`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error("[encrypt-graph-tokens] failed:", (err as Error).message);
  process.exit(1);
});
