/**
 * scripts/rotate-secret-key.ts - re-encrypt at-rest secrets under the primary
 * key (INSTINCT_SECRET_KEY). DRY RUN BY DEFAULT.
 *
 *   npm run security:rotate-secret-key                 # dry run: counts only
 *   npm run security:rotate-secret-key -- --apply      # re-encrypt
 *   npm run security:rotate-secret-key -- --apply --batch-size 10
 *
 * Operator order and verification: docs/security/at-rest-key-rotation.md.
 *
 * The shell must hold the SAME INSTINCT_SECRET_KEY (and
 * INSTINCT_SECRET_KEY_PREVIOUS, if any) as the deployment, and the same
 * INSTINCT_JWT_SECRET state as the deployment so the legacy key derives
 * identically. A legacy value this shell cannot open is counted as
 * "unreadable" and never written.
 *
 * SAFETY (logic in src/lib/crypto/secret-key-rotation.ts, tested against a
 * real Postgres):
 *   - Refuses to run without a valid primary key; a `vercel env pull`
 *     redaction placeholder is refused.
 *   - --apply also refuses until the deployed app is proven to use the same
 *     primary key (a stored value under its key id, or the app's
 *     security.secret_key_primary_active event naming it).
 *   - Proves round-trip on every value before writing; conditional UPDATEs;
 *     small transactions; idempotent and resumable.
 *   - Prints table, column and counts only. Never a value.
 *
 * Exit: 0 done (or dry run), 1 refused, 2 error.
 */
import "./load-env";
import { Client } from "pg";
import {
  ROTATION_TARGETS,
  checkRotationKey,
  proveAppKey,
  rotateSecrets,
  surveySecrets,
  totals,
  type ColumnCounts,
} from "../src/lib/crypto/secret-key-rotation";
import { allowLegacyKeyForRotation, secretKeyringStatus, setSecretKeySignalSink } from "../src/lib/crypto/secret-storage";
import { trackEventAwait } from "../src/lib/analytics";
import { recordAuditNonFatal } from "../src/lib/audit-log";

const TAG = "[rotate-secret-key]";

function printCounts(counts: ColumnCounts[]): void {
  for (const c of counts) {
    if (!c.present) {
      console.log(`  ${c.table}.${c.column}: not present in this database`);
      continue;
    }
    console.log(
      `  ${c.table}.${c.column}: primary=${c.primary} previous=${c.previous} legacy=${c.legacy} plaintext=${c.plaintext} unreadable=${c.unreadable}`,
    );
  }
  const t = totals(counts);
  console.log(`  TOTAL: primary=${t.primary} previous=${t.previous} legacy=${t.legacy} plaintext=${t.plaintext} unreadable=${t.unreadable}`);
}

function batchSizeArg(argv: string[]): number {
  const i = argv.indexOf("--batch-size");
  const n = i >= 0 ? Number(argv[i + 1]) : 25;
  return Number.isInteger(n) && n > 0 ? n : 25;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  /* This process is not the app. Its keyring must never emit
     security.secret_key_primary_active, or proveAppKey would accept the
     operator's own report as proof that the deployment holds the key. */
  setSecretKeySignalSink(() => {});
  /* The app no longer opens legacy values once a primary is set; this
     backfill must, to move them under the primary. */
  allowLegacyKeyForRotation();

  const key = checkRotationKey(process.env);
  if (!key.ok) {
    console.error(`${TAG} REFUSED: ${key.reason}. Put the deployment's INSTINCT_SECRET_KEY (32 bytes, hex or base64) in this shell.`);
    if (key.reason === "redacted_placeholder") console.error(`${TAG} The value is a redaction placeholder from \`vercel env pull\`, not the key.`);
    return 1;
  }
  const ring = secretKeyringStatus();
  console.log(`${TAG} primary key id ${key.primaryKid}; previous keys ${ring.previousKids.length}${ring.invalidPrevious ? ` (${ring.invalidPrevious} invalid, ignored)` : ""}; legacy key id ${ring.legacyKid}`);

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

    const before = await surveySecrets(db);
    console.log(`${TAG} ${apply ? "before" : "dry run"}:`);
    printCounts(before);

    const proof = await proveAppKey(db, key.primaryKid);
    console.log(`${TAG} deployed app uses this primary key: ${proof.ok ? `yes (${proof.via})` : `NOT PROVEN (${proof.reason})`}`);

    if (!apply) {
      console.log(`${TAG} dry run: nothing written. Re-run with --apply to re-encrypt.`);
      return 0;
    }
    if (!proof.ok) {
      console.error(`${TAG} REFUSED: the deployed app is not proven to hold this key. See step 4 of docs/security/at-rest-key-rotation.md.`);
      return 1;
    }

    const result = await rotateSecrets(db, ROTATION_TARGETS, { batchSize: batchSizeArg(argv) });
    console.log(
      `${TAG} rotated=${result.rotated} skipped_concurrent=${result.skippedConcurrent} unreadable=${result.unreadable} round_trip_failures=${result.roundTripFailures}`,
    );

    for (const c of result.perColumn) {
      if (c.rotated === 0) continue;
      await trackEventAwait("security.secret_values_rotated", "system", "system", {
        table: c.table,
        column: c.column,
        rotated: c.rotated,
        primary_kid: key.primaryKid,
      });
    }
    if (result.rotated > 0) {
      await recordAuditNonFatal({
        actor: { user_id: "operator_script", role: "system" },
        action: "security.secret_values_rotated",
        resourceType: "at_rest_key",
        resourceId: key.primaryKid,
        afterState: { rotated: result.rotated, columns: result.perColumn.filter((c) => c.rotated > 0) },
      });
    }

    const after = await surveySecrets(db);
    console.log(`${TAG} after:`);
    printCounts(after);
    const t = totals(after);
    return t.legacy + t.previous === 0 ? 0 : 1;
  } finally {
    await db.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`${TAG} failed:`, (err as Error).message);
    process.exit(2);
  });
