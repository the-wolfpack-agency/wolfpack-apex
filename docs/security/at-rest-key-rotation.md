# At-rest key rotation

Secrets stored in Postgres (connector credentials, Microsoft Graph tokens, QuickBooks tokens, delegation issuer secrets, admin MFA seeds, workspace model keys, tenant connection strings) are encrypted with AES-256-GCM by `src/lib/crypto/secret-storage.ts`. This runbook moves them onto a dedicated key, `INSTINCT_SECRET_KEY`, with no downtime and no unreadable rows.

## How the keyring works

| Key | Source | Used for |
|---|---|---|
| primary | `INSTINCT_SECRET_KEY` (32 bytes, hex or base64) | every new encryption, and decryption |
| previous | `INSTINCT_SECRET_KEY_PREVIOUS` (comma-separated) | decryption only |
| legacy | the original derivation from `INSTINCT_JWT_SECRET` (or its built-in fallback) | used only while no primary is set. Once one is, the app never opens a legacy value; only the operator backfill scripts do, to move it under the primary |

- Values encrypted under the primary carry its key id: `v1.k<16 hex>.<iv>.<tag>.<ct>`. Older values (`v1.<iv>.<tag>.<ct>`) still parse and decrypt. The key id is a hash of the key and does not reveal it.
- With no valid `INSTINCT_SECRET_KEY`, the app behaves exactly as before and, in production, logs a `DEGRADED` line and records `security.secret_key_degraded` once per process.
- With a primary set, the app records `security.secret_key_primary_active { primary_kid }` once per process, and `security.secret_old_key_decrypt { key_class }` once per process the first time it opens a previous-key value (or, in the backfill script, a legacy one).
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

## Sealing QuickBooks tokens and delegation issuer secrets

QuickBooks access and refresh tokens (`instinct_qbo_tokens`) and delegation issuer hs256 secrets (`instinct_delegation_issuers.secret`) are sealed at rest under this keyring like Graph tokens. Every write is sealed, and a write that cannot be sealed is refused. A value the app reads that is not sealed yet is sealed in place on that read. Values nobody reads are sealed by the backfill.

With the same shell as step 5:

```
npm run security:seal-qbo-tokens                       # dry run, read-only
npm run security:seal-qbo-tokens -- --apply
npm run security:seal-delegation-secrets               # dry run, read-only
npm run security:seal-delegation-secrets -- --apply
```

Output is counts only:

- `rows`
- `already_sealed`
- `empty` (for example, an es256 issuer has no secret)
- `to_seal`
- `sealed`
- `failed` (unreadable values, round-trip failures, and rows the app changed mid-run)

The script refuses to write unless this shell's key opens every value the app already sealed. When the shell holds `INSTINCT_SECRET_KEY`, it also refuses unless the deployed app is proven to use that key (step 4). A re-run reports every row as `already_sealed` and writes nothing. Exit codes: 0 done, 1 refused, 2 error, 3 applied with failures. With a primary key in the shell, values are sealed under it directly. Without one, they are sealed under the legacy key, and the rotation in step 5 later moves them to the primary.

`scripts/encrypt-graph-tokens.ts` applies the same app-key proof before sealing Graph tokens.

## Hashing team invite tokens

Team invite tokens (`instinct_invites.token`) are only ever compared, so they are stored as a SHA-256 hash rather than sealed. New invites, accepted invites and resent invites hold only the hash; a resend issues a new token. The accept route matches the hash of the presented token, and still matches an invite that has not been converted yet, so links already in people's inboxes keep working. The backfill converts the rest. It needs no key:

```
npm run security:hash-invite-tokens                    # dry run, read-only
npm run security:hash-invite-tokens -- --apply
```

Output is counts only: `rows`, `already_hashed`, `to_hash`, `hashed`, `failed`. A re-run reports every row as `already_hashed`.

## After the count is zero

Once a primary is set, the app does not open legacy values at all: a legacy value it meets reads as unavailable, and the dry run counts it as `unreadable`. Only the operator backfill scripts (`rotate-secret-key`, `seal-at-rest-secrets`, `encrypt-graph-tokens`) opt back in (`allowLegacyKeyForBackfill`), so a deployment that started without a primary still rotates with steps 5 and 6. A guard test fails if any other code calls it. Production was checked before this change: `legacy=0`, and no `security.secret_old_key_decrypt` event after the rotation run.

## Rotating the primary later

1. Generate a new key (step 1).
2. Move the current value to `INSTINCT_SECRET_KEY_PREVIOUS` and set the new one as `INSTINCT_SECRET_KEY` (same environments as step 2).
3. Redeploy, verify (steps 3 and 4), run the backfill with both keys in the shell (step 5), and verify `previous=0` (step 6).
4. Remove `INSTINCT_SECRET_KEY_PREVIOUS` and redeploy.

## Related

- `src/lib/crypto/secret-storage.ts`: the keyring.
- `src/lib/crypto/secret-key-rotation.ts`: survey, proof and rotation logic.
- `src/db/__tests__/secret-key-rotation.db.test.ts`: the backfill against a real Postgres (rotation, idempotent re-run, resume after a crash).
- `scripts/encrypt-graph-tokens.ts`: seals Graph tokens not sealed yet; separate from key rotation.
- `scripts/seal-at-rest-secrets.ts` and `src/lib/crypto/at-rest-seal-backfill.ts`: seal QuickBooks tokens and delegation issuer secrets not sealed yet; tested in `src/db/__tests__/at-rest-seal-backfill.db.test.ts`.
- `scripts/hash-invite-tokens.ts` and `src/lib/team/invite-tokens.ts`: invite token lookup and hash backfill; tested in `src/db/__tests__/invite-token-hash.db.test.ts`.
- `src/lib/crypto/__tests__/at-rest-secret-columns.test.ts`: fails the build when a migration adds a credential-shaped column that is neither in `ROTATION_TARGETS` nor classified with a reason.
