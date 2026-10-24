/**
 * End a leaked Instinct session: revoke its refresh-token family.
 *
 *   npm run security:revoke-session -- --token-file ~/leaked-token.txt            # dry run
 *   npm run security:revoke-session -- --token-file ~/leaked-token.txt --apply    # revoke
 *   npm run security:revoke-session -- --user-id <id> [--apply]                   # every live family for a user
 *
 * DRY RUN BY DEFAULT. It shows each family's rows (issued, expiry, used,
 * revoked) and writes nothing until --apply. With --apply it calls
 * revokeFamilyTokens (src/lib/crypto/refresh-tokens.ts), which runs
 *   UPDATE instinct_refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL
 * then writes security.session_family_revoked to analytics and
 * auth.session_family.revoked to the hash-chained audit log, and re-reads the
 * family to prove nothing is left unrevoked.
 *
 * The token is read from a file so it never appears on a command line, in
 * shell history or in chat, and it is never printed. DATABASE_URL comes from
 * the environment (this does not read .env.local, so it cannot silently point
 * at the wrong database). Steps: docs/security/incident-runbook.md.
 *
 * Exit: 0 done (or dry run), 1 refused (bad input, token not found, rows left
 * unrevoked), 2 error.
 */
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { query } from "@/lib/db";
import { revokeFamilyTokens } from "@/lib/crypto/refresh-tokens";
import { trackEventAwait } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { USAGE, applyRevocation, countUnrevoked, extractTokenId, parseRevokeArgs, planRevocation, renderPlan, type QueryFn } from "./lib/revoke-session";

async function main(): Promise<number> {
  const args = parseRevokeArgs(process.argv.slice(2));
  if ("error" in args) {
    process.stderr.write(`${args.error}\n\n${USAGE}\n`);
    return 1;
  }
  if (!process.env.DATABASE_URL) {
    process.stderr.write("DATABASE_URL is not set. Export the connection string of the deployment the token belongs to.\n");
    return 1;
  }
  let host = "unknown host";
  try {
    host = new URL(process.env.DATABASE_URL).host;
  } catch {
    /* host is informational only */
  }
  process.stdout.write(`Database: ${host}\n`);

  let target: { tokenId: string } | { userId: string };
  if (args.tokenFile) {
    let content: string;
    try {
      content = readFileSync(args.tokenFile, "utf8");
    } catch (e) {
      process.stderr.write(`Could not read ${args.tokenFile}: ${(e as NodeJS.ErrnoException).code ?? "error"}\n`);
      return 1;
    }
    const tokenId = extractTokenId(content);
    if (!tokenId) {
      process.stderr.write("The token file does not contain an instinct_refresh_token value (a UUID).\n");
      return 1;
    }
    target = { tokenId };
  } else {
    target = { userId: args.userId as string };
  }

  const q = query as unknown as QueryFn;
  const plan = await planRevocation(q, target);
  if (!plan.ok) {
    process.stderr.write(`${plan.message}\n`);
    return 1;
  }
  process.stdout.write(renderPlan(plan.plans, args.apply) + "\n");
  if (!args.apply) return 0;

  const actor = `operator:${userInfo().username}`;
  const done = await applyRevocation(
    { revokeFamily: revokeFamilyTokens, track: trackEventAwait, audit: recordAudit, actor },
    plan.plans,
    "tokenId" in target ? "token" : "user",
    args.reason,
  );

  // Verify: re-read every family and require zero unrevoked rows.
  const left = await countUnrevoked(q, plan.plans.map((p) => p.familyId));
  process.stdout.write(`\nRevoked ${done.reduce((n, d) => n + d.rowsRevoked, 0)} row(s) across ${done.length} family(ies). Unrevoked rows left: ${left}.\n`);
  if (left > 0) {
    process.stderr.write("Some rows are still unrevoked. Re-run, then check the database by hand.\n");
    return 1;
  }
  process.stdout.write("Recorded security.session_family_revoked and audit auth.session_family.revoked.\n");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`security:revoke-session failed: ${(e as Error).message}\n`);
    process.exit(2);
  },
);
