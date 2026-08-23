/**
 * provision-e2e-account.ts: the dedicated login the browser tests sign in as.
 *
 * WHY THIS EXISTS AS A SCRIPT
 *
 * Because it will be needed again: for a second environment, after a rotation,
 * or the first time somebody stands this product up for a client. A credential
 * created by hand in a psql session is one nobody can recreate the same way,
 * and the password ends up pasted somewhere it should not be. This is the
 * repeated process, codified.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not grant admin. The account is created at the LEAST privilege that
 * still lets the browser tests see what they need, because the password ends
 * up in a CI secret store, and a credential that can reach an admin surface is
 * worth stealing in a way that one which can read its own routines is not. If a
 * future spec needs an admin page, that is a separate decision somebody makes
 * on purpose rather than a privilege that arrived quietly with a test.
 *
 * It also does not print the password more than once, and never writes it to a
 * file. Capture it from the output or generate a new one.
 *
 * Usage:
 *   npx tsx scripts/provision-e2e-account.ts [--dry-run] [--rotate]
 *
 * Needs: DATABASE_URL.
 *
 * Rerunning without --rotate is safe and idempotent: an existing account keeps
 * its password, so a re-run cannot silently break a CI job that is using it.
 */
import { randomBytes } from "crypto";
import { hashPassword } from "@/lib/auth";
import { query } from "@/lib/db";

const DRY = process.argv.includes("--dry-run");
const ROTATE = process.argv.includes("--rotate");

/**
 * The roles worth having a test account for.
 *
 * WHY NOT ALL TEN. ceo, cto, evp, vp and cco are deliberately absent. Their
 * credentials would live in a CI secret store readable by any workflow anybody
 * with repository write access can push, and a full-admin production login is
 * worth stealing in a way that one which can read its own routines is not.
 *
 * The five here are where the bugs are anyway. Most people in a workspace hold
 * one of them, and a page that misbehaves for an ordinary employee is a page
 * that misbehaves for almost everybody. The first non-admin account found the
 * dashboard asking an admin endpoint on every load within a minute of existing.
 */
export const TEST_ROLES = ["designer", "sales", "ops", "hr", "dev"] as const;

/** One address per role, so a failure names the role in its own error. */
export function emailForRole(role: string): string {
  return role === "designer"
    ? (process.env.E2E_ACCOUNT_EMAIL ?? "e2e@thewolfpack.agency")
    : `e2e-${role}@thewolfpack.agency`;
}

const EMAIL = process.env.E2E_ACCOUNT_EMAIL ?? "e2e@thewolfpack.agency";
const NAME = "E2E (automated tests)";
/** Least privilege that still reaches the SELF_SERVICE pages under test. */
const ROLE = "member";
const WORKSPACE = "default";

/** 24 bytes of base64url. Long enough that nobody is tempted to type it. */
function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Provision one account per role, all sharing a single generated password.
 *
 * ONE PASSWORD FOR ALL OF THEM is a deliberate call, not laziness. They are the
 * same account in every way that matters: same blast radius class, same
 * lifecycle, revoked together. Ten secrets would mean ten things to rotate and
 * nine chances to forget one, and the honest risk is the credential leaking at
 * all rather than which of five it was.
 *
 * None of them is an admin, which is what keeps that calculation true.
 */
async function provisionAll(): Promise<void> {
  const password = generatePassword();
  const created: string[] = [];

  for (const role of TEST_ROLES) {
    const email = emailForRole(role);
    if (DRY) {
      console.log(`[dry-run] would provision ${email} as ${role}.`);
      continue;
    }
    const existing = await query<{ id: string }>(
      `SELECT id FROM instinct_team_members WHERE LOWER(email) = LOWER($1)`,
      [email],
    );
    if (existing.rows.length > 0) {
      await query(
        `UPDATE instinct_team_members
            SET password_hash = $2, role = $3, is_active = true
          WHERE LOWER(email) = LOWER($1)`,
        [email, hashPassword(password), role],
      );
    } else {
      await query(
        `INSERT INTO instinct_team_members (id, email, name, role, password_hash, workspace_id, is_active)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, true)`,
        [email, `E2E ${role} (automated tests)`, role, hashPassword(password), WORKSPACE],
      );
    }
    created.push(`${email} (${role})`);
  }

  if (DRY) return;

  console.log(`Provisioned ${created.length} accounts, all with one password:`);
  for (const c of created) console.log(`  ${c}`);
  console.log("");
  console.log("Password (shown once, not stored anywhere by this script):");
  console.log(`  ${password}`);
  console.log("");
  console.log("Store it:  gh secret set ADMIN_E2E_PASSWORD --body '<the password above>'");
  console.log("");
  console.log("To revoke every one of them:");
  console.log("  UPDATE instinct_team_members SET is_active = false WHERE email LIKE 'e2e%@thewolfpack.agency';");
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Nothing written.");
    process.exitCode = 1;
    return;
  }

  /* --all provisions the whole set. Without it the script keeps its original
     single-account behaviour, so an existing CI job cannot change meaning
     because somebody added a flag. */
  if (process.argv.includes("--all")) {
    await provisionAll();
    return;
  }

  const existing = await query<{ id: string; role: string; is_active: boolean }>(
    `SELECT id, role, is_active FROM instinct_team_members WHERE LOWER(email) = LOWER($1)`,
    [EMAIL],
  );

  if (existing.rows.length > 0 && !ROTATE) {
    const row = existing.rows[0];
    console.log(`Account already exists: ${EMAIL} (role ${row.role}, active ${row.is_active}).`);
    console.log("Its password is unchanged. Re-run with --rotate to issue a new one.");
    return;
  }

  const password = generatePassword();

  if (DRY) {
    console.log(`[dry-run] would ${existing.rows.length ? "rotate" : "create"} ${EMAIL} as ${ROLE}.`);
    return;
  }

  if (existing.rows.length > 0) {
    await query(
      `UPDATE instinct_team_members
          SET password_hash = $2, role = $3, is_active = true
        WHERE LOWER(email) = LOWER($1)`,
      [EMAIL, hashPassword(password), ROLE],
    );
  } else {
    await query(
      `INSERT INTO instinct_team_members (id, email, name, role, password_hash, workspace_id, is_active)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, true)`,
      [EMAIL, NAME, ROLE, hashPassword(password), WORKSPACE],
    );
  }

  console.log(`${existing.rows.length ? "Rotated" : "Created"} ${EMAIL} as ${ROLE}.`);
  console.log("");
  console.log("Password (shown once, not stored anywhere by this script):");
  console.log(`  ${password}`);
  console.log("");
  console.log("Store it:");
  console.log(`  gh secret set ADMIN_E2E_EMAIL --body '${EMAIL}'`);
  console.log("  gh secret set ADMIN_E2E_PASSWORD --body '<the password above>'");
  console.log("");
  console.log("To revoke: UPDATE instinct_team_members SET is_active = false WHERE email = '" + EMAIL + "';");
}

void main().then(
  () => process.exit(0),
  (err) => {
    console.error("Failed:", (err as Error).message);
    process.exit(1);
  },
);
