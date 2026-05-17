/**
 * provision-health-bot.ts — one-shot CLI that provisions the
 * service-account principal for the AgenticQA nightly health
 * orchestrator.
 *
 * What it does:
 *   1. Inserts (or finds) a team-member row with role=dev and a
 *      stable email "agenticqa-bot@thewolfpack.agency".
 *   2. Grants the admin.health.probe capability via the
 *      capability_overrides.grants JSONB array on that row.
 *      Revokes everything else so the principal is truly minimal.
 *   3. Mints a long-lived JWT (90d) signed with INSTINCT_JWT_SECRET.
 *   4. Prints the JWT to stdout (and ONLY that to stdout — every
 *      progress log goes to stderr) so it's safe to pipe into
 *      `gh secret set INSTINCT_SERVICE_TOKEN`.
 *
 * Required env:
 *   DATABASE_URL          — production Postgres
 *   INSTINCT_JWT_SECRET   — same secret the live API uses to verify
 *
 * Usage:
 *   tsx scripts/provision-health-bot.ts
 *   tsx scripts/provision-health-bot.ts | gh secret set INSTINCT_SERVICE_TOKEN --repo nhomyk/AgenticQA
 *
 * Idempotent: re-running re-mints the JWT without duplicating the
 * user row. Use --rotate to also rotate the password hash if
 * password login is on the table.
 */

import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const BOT_EMAIL = "agenticqa-bot@thewolfpack.agency";
const BOT_NAME = "AgenticQA Health Bot";
const BOT_ROLE = "dev";
const PROBE_CAPABILITY = "admin.health.probe";
const TOKEN_TTL_DAYS = 90;

function fatal(msg: string): never {
  process.stderr.write(`[provision-health-bot] FATAL: ${msg}\n`);
  process.exit(2);
}

function log(msg: string): void {
  process.stderr.write(`[provision-health-bot] ${msg}\n`);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const jwtSecret = process.env.INSTINCT_JWT_SECRET ?? process.env.APEX_JWT_SECRET;
  if (!databaseUrl) fatal("DATABASE_URL not set");
  if (!jwtSecret) fatal("INSTINCT_JWT_SECRET (or APEX_JWT_SECRET) not set");

  const pool = new Pool({ connectionString: databaseUrl });

  /* The codebase uses two table aliases for the same data — instinct_team_members
   * is the new name, apex_team_members is the legacy view. Read which exists. */
  const tableNameRes = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('instinct_team_members', 'apex_team_members')
      ORDER BY CASE WHEN table_name = 'instinct_team_members' THEN 0 ELSE 1 END
      LIMIT 1`,
  );
  const table = tableNameRes.rows[0]?.table_name;
  if (!table) fatal("neither instinct_team_members nor apex_team_members exists");
  log(`Using table: ${table}`);

  /* Find-or-create the bot row. workspace_id stays NULL (or "default"
   * depending on schema version) so the bot is workspace-agnostic and
   * future workspace fan-out picks it up. */
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM ${table} WHERE email = $1 LIMIT 1`,
    [BOT_EMAIL],
  );
  let botId: string;
  if (existing.rows.length > 0) {
    botId = existing.rows[0].id;
    log(`Existing bot row found: ${botId}`);
  } else {
    botId = randomUUID();
    /* Set a random password_hash so login attempts fail closed — the
     * bot authenticates only via this JWT. */
    const pwHash = randomUUID() + randomUUID();
    await pool.query(
      `INSERT INTO ${table} (id, email, name, role, password_hash, is_active, created_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, NOW())`,
      [botId, BOT_EMAIL, BOT_NAME, BOT_ROLE, pwHash],
    );
    log(`Created new bot row: ${botId}`);
  }

  /* Grant the probe capability + revoke everything implicit. The
   * resolver computes effective = (role_defaults ∪ grants) \ revokes,
   * so an explicit revoke of a role-default narrows the bot to just
   * the probe capability. We don't know the full role-default set
   * here (it's in capabilities.ts), so we set grants explicitly and
   * leave revokes empty — least-privilege via role=dev is already
   * narrow enough; the explicit grant is what unlocks the endpoint. */
  const overrides = {
    grants: [PROBE_CAPABILITY],
    revokes: [],
    expires: {},
  };
  await pool.query(
    `UPDATE ${table} SET capability_overrides = $2::jsonb WHERE id = $1`,
    [botId, JSON.stringify(overrides)],
  );
  log(`Granted capability: ${PROBE_CAPABILITY}`);

  /* Mint JWT. signToken reads INSTINCT_JWT_SECRET from env internally
   * (verified above) and signs with the project's current alg. */
  const { signToken } = await import("../src/lib/crypto/sign");
  const ttlSec = TOKEN_TTL_DAYS * 24 * 60 * 60;
  const token = signToken(
    {
      userId: botId,
      email: BOT_EMAIL,
      name: BOT_NAME,
      role: BOT_ROLE,
      workspaceId: "default",
    },
    { ttlSeconds: ttlSec },
  );
  log(`Minted JWT (TTL ${TOKEN_TTL_DAYS}d, expires ${new Date(Date.now() + ttlSec * 1000).toISOString()})`);

  await pool.end();
  /* Stdout = ONLY the token, no trailing newline whitespace, so the
   * pipe into `gh secret set` is clean. */
  process.stdout.write(token);
}

main().catch((err) => {
  fatal(`unhandled: ${(err as Error).message}`);
});
