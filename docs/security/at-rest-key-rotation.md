# At-rest key rotation

Secrets stored in Postgres (connector credentials, Microsoft Graph tokens, admin MFA seeds, workspace model keys, tenant connection strings) are encrypted with AES-256-GCM by `src/lib/crypto/secret-storage.ts`. This runbook moves them onto a dedicated key, `INSTINCT_SECRET_KEY`, with no downtime and no unreadable rows.

## How the keyring works

| Key | Source | Used for |
|---|---|---|
| primary | `INSTINCT_SECRET_KEY` (32 bytes, hex or base64) | every new encryption, and decryption |
| previous | `INSTINCT_SECRET_KEY_PREVIOUS` (comma-separated) | decryption only |
| legacy | the original derivation from `INSTINCT_JWT_SECRET` (or its built-in fallback) | decryption only, once a primary is set |

- Values encrypted under the primary carry its key id: `v1.k<16 hex>.<iv>.<tag>.<ct>`. Older values (`v1.<iv>.<tag>.<ct>`) still parse and decrypt. The key id is a hash of the key and does not reveal it.
- With no valid `INSTINCT_SECRET_KEY`, the app behaves exactly as before and, in production, logs a `DEGRADED` line and records `security.secret_key_degraded` once per process.
- With a primary set, the app records `security.secret_key_primary_active { primary_kid }` once per process, and `security.secret_old_key_decrypt { key_class }` once per process the first time it opens a legacy or previous-key value.
- The backfill, `npm run security:rotate-secret-key`, counts values per table and column by key (dry run, the default) and with `--apply` re-encrypts legacy and previous-key values under the primary.

## Operator steps

Run these in order. Times are whatever is convenient; nothing here needs a maintenance window.

1. **Generate 32 random bytes.** On your machine:

   ```
   openssl rand -hex 32
   ```

   Keep the 64-character output in your password manager. It is not stored anywhere else and cannot be recovered.

2. **Set `INSTINCT_SECRET_KEY` in Vercel.** In the `wolfpack-instinct` project, Settings, Environment Variables, add `INSTINCT_SECRET_KEY` with the value from step 1, marked Sensitive, for **Production**. If Preview deployments use the same `DATABASE_URL` as Production, add the **same** value to Preview too. A Preview with a different key, or with none, writing to the shared database would undo the rotation. Do not change `INSTINCT_JWT_SECRET` (or add one) until step 6 reads zero: the legacy key is derived from it.

   CLI equivalent: `npx vercel env add INSTINCT_SECRET_KEY production` and paste the value when prompted.

3. **Redeploy Production.** `npx vercel --prod` from the repo, or Redeploy on the latest production deployment in the Vercel dashboard. Environment variables apply only to new deployments.

4. **Verify new writes use the primary key.** Sign in to https://wolfpack-instinct.vercel.app and open any page that reads a stored secret (the dashboard with Microsoft connected, or an admin page behind MFA). Then either:

   - run the step 5 dry run and check it prints `deployed app uses this primary key: yes`, or
   - query the events table (read-only):

     ```sql
     SELECT event_type, metadata->>'primary_kid' AS kid, metadata->>'reason' AS reason, timestamp
       FROM instinct_events
      WHERE event_type IN ('security.secret_key_primary_active', 'security.secret_key_degraded')
      ORDER BY timestamp DESC LIMIT 10;
     ```

     Rows after the redeploy should be `security.secret_key_primary_active` with the key id the script prints for your key, and no new `security.secret_key_degraded`.

   Values the app writes from now on start with `v1.k<that key id>.`; this count rises as tokens refresh:

   ```sql
   SELECT count(*) FROM instinct_ms_tokens WHERE access_token LIKE 'v1.k%';
   ```

5. **Run the backfill: dry run, then `--apply`.** From the repo root, with `DATABASE_URL` for production in `.env.local` (the script loads it) or exported:

   ```
   read -rs INSTINCT_SECRET_KEY && export INSTINCT_SECRET_KEY
   unset INSTINCT_JWT_SECRET INSTINCT_SECRET_KEY_PREVIOUS
   npm run security:rotate-secret-key
   ```

   Paste the key at the silent prompt so it stays out of shell history. The shell must match production: if production has `INSTINCT_JWT_SECRET` or `INSTINCT_SECRET_KEY_PREVIOUS` set, export the same values instead of unsetting them. The dry run is read-only and prints, per table and column, `primary`, `previous`, `legacy`, `plaintext` and `unreadable` counts. `unreadable` must be 0; if it is not, the shell does not match production, so stop and fix the shell.

   Then:

   ```
   npm run security:rotate-secret-key -- --apply
   ```

   The script refuses to run if the key is missing, malformed, or a `vercel env pull` redaction placeholder, and `--apply` refuses until step 4's proof holds. Every value is decrypted, re-encrypted, and decrypted again and compared before it is written. Updates are conditional on the stored value being unchanged and run in small transactions, so a concurrent app write wins and an interrupted run is finished by running it again. Output is counts only.

6. **Verify the legacy count is zero.** Run the dry run again (`npm run security:rotate-secret-key`). `TOTAL` must show `legacy=0 previous=0`. The `--apply` run exits non-zero if either is still above zero. Over the following days `security.secret_old_key_decrypt` should stop appearing in `instinct_events`.

## After the count is zero

The legacy fallback stays in `secret-storage.ts` until a follow-up change removes it. That change is safe only after step 6 reads zero on every database that shares this code (production, and any Preview database), and after a period with no `security.secret_old_key_decrypt` events. Removing it earlier would make any remaining legacy value unreadable.

## Rotating the primary later

1. Generate a new key (step 1).
2. Move the current value to `INSTINCT_SECRET_KEY_PREVIOUS` and set the new one as `INSTINCT_SECRET_KEY` (same environments as step 2).
3. Redeploy, verify (steps 3 and 4), run the backfill with both keys in the shell (step 5), and verify `previous=0` (step 6).
4. Remove `INSTINCT_SECRET_KEY_PREVIOUS` and redeploy.

## Related

- `src/lib/crypto/secret-storage.ts`: the keyring.
- `src/lib/crypto/secret-key-rotation.ts`: survey, proof and rotation logic.
- `src/db/__tests__/secret-key-rotation.db.test.ts`: the backfill against a real Postgres (rotation, idempotent re-run, resume after a crash).
- `scripts/encrypt-graph-tokens.ts`: seals legacy plaintext Graph tokens; separate from key rotation.
