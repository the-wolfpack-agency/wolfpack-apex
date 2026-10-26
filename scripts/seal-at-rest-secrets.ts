/**
 * scripts/seal-at-rest-secrets.ts - seal values in a sealed-at-rest column
 * that are not sealed yet. DRY RUN BY DEFAULT.
 *
 *   npm run security:seal-qbo-tokens                       # QuickBooks tokens, dry run
 *   npm run security:seal-qbo-tokens -- --apply
 *   npm run security:seal-delegation-secrets               # delegation issuer secrets, dry run
 *   npm run security:seal-delegation-secrets -- --apply
 *
 * The app seals every value it writes and re-seals an unsealed value on its
 * first read, so this is for rows nobody reads. It is a script, not a
 * migration, because sealing needs the application key. The shell must hold
 * the deployment's INSTINCT_SECRET_KEY (and INSTINCT_JWT_SECRET state), as for
 * docs/security/at-rest-key-rotation.md.
 *
 * SAFETY (logic in src/lib/crypto/at-rest-seal-backfill.ts, tested against a
 * real Postgres): refuses to write unless this shell's key opens every value
 * the app already sealed and, when the shell has a primary key, the deployed
 * app is proven to use it; round-trip proof per row; conditional UPDATEs;
 * idempotent. Prints counts only, never a value or a row identifier.
 *
 * Exit: 0 done (or dry run), 1 refused, 2 error, 3 applied with failures.
 */
import "./load-env";
import { Client } from "pg";
import { SEAL_TARGETS, sealAtRest, type SealTargetName } from "../src/lib/crypto/at-rest-seal-backfill";
import { allowLegacyKeyForBackfill, setSecretKeySignalSink } from "../src/lib/crypto/secret-storage";
import { recordAuditNonFatal } from "../src/lib/audit-log";

async function main(): Promise<number> {
  const name = process.argv[2] as SealTargetName;
  const apply = process.argv.includes("--apply");
  const target = SEAL_TARGETS[name];
  const TAG = `[seal-at-rest:${name ?? "?"}]`;
  if (!target) {
    console.error(`${TAG} usage: seal-at-rest-secrets.ts <${Object.keys(SEAL_TARGETS).join("|")}> [--apply]`);
    return 1;
  }
  /* This process is not the app: its keyring must never report itself as the
     deployment (proveAppKey reads that report). */
  setSecretKeySignalSink(() => {});
  allowLegacyKeyForBackfill(); // the app no longer opens legacy values once a primary is set; this backfill must

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`${TAG} DATABASE_URL is not set.`);
    return 1;
  }
  const local = url.includes("localhost") || url.includes("127.0.0.1");
  const db = new Client({ connectionString: url, ssl: local ? undefined : { rejectUnauthorized: false } });
  await db.connect();
  try {
    if (!apply) await db.query("SET default_transaction_read_only = on");
    const r = await sealAtRest(db, target, { apply });
    if (!r.present) {
      console.log(`${TAG} ${r.table} is not present in this database; nothing to do.`);
      return 0;
    }
    console.log(
      `${TAG} key check: ${r.key.ok ? `ok (verified against ${r.key.verifiedAgainst} sealed value(s); app key: ${r.key.appKey})` : `REFUSED (${r.key.reason})`}`,
    );
    console.log(
      `${TAG} rows=${r.rows} already_sealed=${r.alreadySealed} empty=${r.empty} to_seal=${r.toSeal} sealed=${r.sealed} failed=${r.failed}` +
        ` (unreadable=${r.unreadable} round_trip_failures=${r.roundTripFailures} skipped_concurrent=${r.skippedConcurrent})`,
    );
    if (!apply) {
      console.log(`${TAG} dry run: nothing written. Re-run with --apply to seal.`);
      return 0;
    }
    if (r.toSeal > 0 && !r.key.ok) {
      console.error(`${TAG} REFUSED: this shell's key is not proven to be the app's key. Nothing written.`);
      return 1;
    }
    if (r.sealed > 0) {
      await recordAuditNonFatal({
        actor: { user_id: "operator_script", role: "system" },
        action: target.event,
        resourceType: "at_rest_secret",
        resourceId: target.table,
        afterState: { sealed: r.sealed, already_sealed: r.alreadySealed, failed: r.failed },
      });
    }
    return r.failed > 0 ? 3 : 0;
  } finally {
    await db.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("[seal-at-rest] failed:", (err as Error).message);
    process.exit(2);
  });
