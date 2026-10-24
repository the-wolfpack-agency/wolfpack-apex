# Incident runbook: leaked Instinct session

Use this when an Instinct session cookie (`instinct_access_token`, `instinct_refresh_token`) or a Bearer token has been exposed: in a public Actions artifact, a log, a screenshot, a chat message, a support ticket.

## Why each step matters

- The access token is a JWT valid for 15 minutes. Waiting it out is fine; it cannot be revoked and does not need to be.
- The refresh token is valid for 7 days and its cookie value is the row id in `instinct_refresh_tokens`. Each refresh rotates to a new row in the same `family_id`, so the token that leaked may already be "used" while the live head of its family is not. Revoking the **family** ends both.
- An artifact in a public repository stays downloadable until it expires (90 days by default). Delete it first, so the window closes before anything else.

## Steps

Record the Eastern time of each step in the incident note.

### 1. Find every exposure

```bash
npm run security:public-artifacts            # every public repo in the org
npm run security:public-artifacts -- --repo wolfpack-apex
```

The report (`scripts/security/out/public-artifacts.md`) lists each artifact, file and pattern, with the run page and the delete command. It never prints the token.

### 2. Delete the artifact

For each finding, either open the run page in the `Source` column and use the trash icon next to the artifact, or run the command from the finding:

```bash
gh api -X DELETE repos/the-wolfpack-agency/<repo>/actions/artifacts/<artifact-id>
```

Then confirm it is gone (expect HTTP 404):

```bash
gh api repos/the-wolfpack-agency/<repo>/actions/artifacts/<artifact-id>
```

### 3. Dry run the revocation

Put the refresh-token value in a file, never on a command line or in chat. The file may hold the bare value, a `instinct_refresh_token=<value>` cookie line, or the Playwright storage-state JSON.

```bash
umask 077
pbpaste > ~/leaked-refresh-token.txt          # macOS; or write the file with an editor
export DATABASE_URL='<production connection string from Vercel>'
npm run security:revoke-session -- --token-file ~/leaked-refresh-token.txt
```

It prints the database host, then each family with every row's issued time, expiry and state (`LIVE`, `used (rotated)`, `revoked`, `expired`). Nothing is written. If it says the token does not exist, `DATABASE_URL` points at the wrong deployment.

When many tokens leaked for one account (a trace records every rotation), end every live family for that user instead. The user id is the `userId` claim of the leaked access JWT, or the `user` column of the dry run:

```bash
npm run security:revoke-session -- --user-id <user-id>
```

This also signs that user out on their own devices.

### 4. Apply

```bash
npm run security:revoke-session -- --token-file ~/leaked-refresh-token.txt --apply --reason "public artifact <artifact-id>"
# or
npm run security:revoke-session -- --user-id <user-id> --apply --reason "public artifact <artifact-id>"
```

This runs `revokeFamilyTokens` (`UPDATE instinct_refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`), writes `security.session_family_revoked` to analytics and `auth.session_family.revoked` to the audit log, then re-reads the families and fails if any row is still unrevoked.

### 5. Verify

1. Re-run the dry run from step 3. Every row must read `revoked` and the summary `unrevoked 0  live 0`.
2. Re-run `npm run security:public-artifacts`. The deleted artifacts must be gone from the report.
3. Delete the token file: `rm -P ~/leaked-refresh-token.txt` (macOS) or `shred -u` (Linux).

### 6. Close the hole

Find what published it and add a guardrail so it cannot happen again. For Actions artifacts the guardrail is `src/__tests__/no-public-test-artifacts.test.ts`: any upload of Playwright output must be gated on `github.event.repository.private`. Artifacts uploaded before a gate merged stay public until deleted, which is why step 1 scans what is actually published rather than the workflow files.

## Related

- Scheduled scan: `.github/workflows/security-public-artifacts.yml`, [scheduled-checks.md](scheduled-checks.md).
- Monthly review: [monthly-review.md](monthly-review.md).
