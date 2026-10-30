/**
 * Forcefield live red-team: send the adversarial corpus at a DEPLOYED Forcefield
 * target (the shim in enforce mode) and verify the real end-to-end block. This is
 * the true "prove a real live block on a real site" proof, the one claim the whole
 * pitch rests on.
 *
 *   FORCEFIELD_REDTEAM_TARGET=https://our-test-site npm run forcefield:redteam
 *
 * FIRST-PARTY ONLY: this sends hostile-looking requests (scanner UAs, injection
 * payloads in the query), so it must only ever point at a target WE own and have
 * stood up for this test. It refuses to run without an explicit target. Read-only
 * GETs; it never sends a real exploit body, only the request SHAPE the engine keys
 * on. Exits non-zero if any hostile case is NOT blocked or any benign case IS.
 *
 * Reuses the SAME corpus the CI engine test uses, so the live run and the unit
 * proof can never drift.
 *
 * OUR TRAFFIC IS MARKED: every request carries x-forcefield-synthetic with
 * FORCEFIELD_SYNTHETIC_TOKEN, so the engine stamps the events synthetic and they never
 * count as real attacks on the board, in the digest or in a replay. Unmarked proof runs
 * were once counted as real attacks. It refuses to run without
 * the token, and with DATABASE_URL set it reads back the rows the run caused and fails if
 * any is unmarked (which also catches a target whose deployment lacks the token).
 */
import { ADVERSARIAL_CORPUS } from "../src/lib/forcefield-web/adversarial-corpus";
import { SYNTHETIC_HEADER } from "../src/lib/forcefield-web/monitor";
import { unmarkedProofRows } from "./lib/forcefield-proof-readback";

const TARGET = process.env.FORCEFIELD_REDTEAM_TARGET?.replace(/\/+$/, "");
const SYNTHETIC_TOKEN = (process.env.FORCEFIELD_SYNTHETIC_TOKEN ?? "").trim();

async function run(): Promise<number> {
  if (!TARGET) {
    console.error("Refusing to run: set FORCEFIELD_REDTEAM_TARGET to a FIRST-PARTY site you own, with the Forcefield shim in enforce mode.");
    return 2;
  }
  if (SYNTHETIC_TOKEN.length < 32) {
    console.error("Refusing to run: set FORCEFIELD_SYNTHETIC_TOKEN (the same value the target deployment holds), so this proof is recorded as our own traffic, never as real attacks.");
    return 2;
  }
  const startedAt = new Date();
  console.log(`Forcefield live red-team -> ${TARGET}  (${ADVERSARIAL_CORPUS.length} cases)`);
  let failures = 0;
  let hostileBlocked = 0;
  let hostileTotal = 0;

  for (const c of ADVERSARIAL_CORPUS) {
    const url = `${TARGET}${c.input.rawUrl ?? c.input.path}`;
    let status = 0;
    let blocked = false;
    try {
      const res = await fetch(url, {
        method: "GET", // read-only; the engine keys on the request SHAPE, not a body
        headers: { "user-agent": c.input.userAgent, [SYNTHETIC_HEADER]: SYNTHETIC_TOKEN },
        redirect: "manual",
      });
      status = res.status;
      blocked = status === 403 || res.headers.get("x-forcefield")?.startsWith("blocked") === true;
    } catch (err) {
      console.log(`  ERROR ${c.name}: ${(err as Error).message}`);
      failures++;
      continue;
    }

    if (c.kind === "hostile") {
      hostileTotal++;
      if (blocked) { hostileBlocked++; console.log(`  PASS  [blocked ${status}] ${c.name}`); }
      else { failures++; console.log(`  FAIL  [NOT blocked ${status}] ${c.name}`); }
    } else {
      // benign + recon must NOT be blocked (a false positive is the worst outcome)
      if (blocked) { failures++; console.log(`  FAIL  [false positive ${status}] ${c.name}`); }
      else console.log(`  PASS  [allowed ${status}] ${c.name}`);
    }
  }

  const rate = hostileTotal ? Math.round((hostileBlocked / hostileTotal) * 100) : 0;
  console.log(`\nHostile blocked: ${hostileBlocked}/${hostileTotal} (${rate}%). Failures: ${failures}.`);

  if (process.env.DATABASE_URL) {
    // Events are forwarded asynchronously; give them a moment to land.
    await new Promise((r) => setTimeout(r, 10_000));
    const unmarked = await unmarkedProofRows(startedAt, ADVERSARIAL_CORPUS.map((c) => c.input.path));
    if (unmarked === null) console.log("Read-back skipped: the events table could not be read.");
    else if (unmarked > 0) { failures++; console.log(`FAIL  ${unmarked} event(s) from this run are NOT marked synthetic: the target does not hold FORCEFIELD_SYNTHETIC_TOKEN, so they count as real attacks.`); }
    else console.log("Read-back: every event from this run is marked synthetic.");
  } else {
    console.log("Read-back skipped (no DATABASE_URL): run with it to prove the events were recorded as our own traffic.");
  }
  return failures === 0 ? 0 : 1;
}

run().then((code) => process.exit(code));
