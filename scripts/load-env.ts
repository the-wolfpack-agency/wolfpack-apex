/**
 * Load .env.local BEFORE anything reads process.env. Import this first.
 *
 * WHY A WHOLE MODULE FOR ONE LINE. The obvious version does not work:
 *
 *     import { config } from "dotenv";
 *     config({ path: ".env.local" });     // looks like it runs first
 *     import { query } from "@/lib/db";   // ...but this already ran
 *
 * Imports are hoisted. Every imported module is evaluated before any statement
 * in the importing file, so db.ts reads DATABASE_URL while the env is still
 * empty, captures undefined into its pool config, and every query afterwards
 * fails. The env is populated by the time the script's own body runs, so
 * `process.env.DATABASE_URL` LOOKS present and a guard that checks it passes,
 * which is what makes this so hard to see.
 *
 * That is not hypothetical. The mapper shipped with the obvious version,
 * walked a client system for 216 seconds, printed a complete map, and stored
 * nothing: "connection is insecure". The map was gone.
 *
 * A side-effect import fixes it because the RELATIVE order of imports is
 * preserved. This module's body runs before the next import's, so anything
 * imported after it sees a populated environment.
 *
 * Usage, and the order is the whole point:
 *
 *     import "./load-env";
 *     import { query } from "@/lib/db";
 */
import { config } from "dotenv";

config({ path: ".env.local" });
