/**
 * scripts/hash-invite-tokens.ts - store every team invite token as its
 * SHA-256 hash. DRY RUN BY DEFAULT.
 *
 *   npm run security:hash-invite-tokens               # dry run: counts only
 *   npm run security:hash-invite-tokens -- --apply
 *
 * Run after the deploy that hashes new invites and looks invites up by hash.
 * Outstanding invite links keep working: the accept route hashes what it is
 * given. Needs no key. Conditional UPDATEs; idempotent. Prints counts only.
 * Logic and tests: src/lib/team/invite-tokens.ts,
 * src/db/__tests__/invite-token-hash.db.test.ts.
 *
 * Exit: 0 done (or dry run), 1 refused, 2 error, 3 applied with failures.
 */
import "./load-env";
import { Client } from "pg";
import { hashInviteTokens } from "../src/lib/team/invite-tokens";
import { recordAuditNonFatal } from "../src/lib/audit-log";

const TAG = "[hash-invite-tokens]";

async function main(): Promise<number> {
  const apply = process.argv.includes("--apply");
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
    const r = await hashInviteTokens(db, { apply });
    if (!r.present) {
      console.log(`${TAG} instinct_invites is not present in this database; nothing to do.`);
      return 0;
    }
    console.log(`${TAG} rows=${r.rows} already_hashed=${r.alreadyHashed} to_hash=${r.toHash} hashed=${r.hashed} failed=${r.failed} (skipped_concurrent=${r.skippedConcurrent})`);
    if (!apply) {
      console.log(`${TAG} dry run: nothing written. Re-run with --apply to hash.`);
      return 0;
    }
    if (r.hashed > 0) {
      await recordAuditNonFatal({
        actor: { user_id: "operator_script", role: "system" },
        action: "security.invite_tokens_hashed",
        resourceType: "team_invite",
        resourceId: "instinct_invites",
        afterState: { hashed: r.hashed, already_hashed: r.alreadyHashed, failed: r.failed },
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
    console.error(`${TAG} failed:`, (err as Error).message);
    process.exit(2);
  });
