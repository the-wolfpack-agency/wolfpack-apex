# scripts/

Task-scaffolding scripts. Each one codifies a repeated manual process so
it runs without LLM assistance.

| Script                              | Purpose                                                                 | Usage                                                                                             |
|-------------------------------------|-------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------|
| `add-capability.sh`                 | Register a new auth capability + attach to roles                         | `./scripts/add-capability.sh <id> <role1,role2,...> "<description>"`                              |
| `add-notification-category.sh`      | Register a notification category, update README, scaffold stub test      | `./scripts/add-notification-category.sh <cat-id> --source <src> --priority <p> [--digest <win>]`  |
| `recall.sh`                         | Search the local knowledge base (Qdrant → Instinct API → graceful error) | `./scripts/recall.sh "<query>" [--top <n>]`                                                       |
| `handoff-scaffold.mjs`              | Scaffold a session handoff doc from git history                          | `npm run handoff`                                                                                 |
| `migrate.mjs`                       | Run pending SQL migrations                                               | `npm run migrate`                                                                                 |
| `verify-tls-hybrid.sh`              | Verify PQ/hybrid TLS configuration                                       | `./scripts/verify-tls-hybrid.sh`                                                                  |

## Conventions

- All scripts exit with Unix codes: `0` success, `2` user error, `1` system
  error.
- Everything is idempotent: re-running is safe.
- No new runtime deps. Bash + node built-ins + Python stdlib only.
- Tests live alongside other unit tests under `src/__tests__/*-script.test.ts`.

## Adding a new capability (example)

```bash
./scripts/add-capability.sh hr.payroll.override "ceo,cto" \
    "Override payroll calculations manually"
```

This will:

1. Append the capability to `src/lib/auth/capabilities.ts`.
2. Add the capability to each listed role's explicit array in
   `src/lib/auth/role-capabilities.ts` (cto/ceo inherit via `ALL_CAPS` so
   they are not touched).
3. Run `capability-coverage.test.ts` to confirm no route regressed.
4. Print the snippet you need to gate a route.

## Adding a notification category (example)

```bash
./scripts/add-notification-category.sh hr.document_expiring \
    --source hr --priority normal --digest daily
```

This creates / upserts `src/lib/notifications/categories.ts`, adds a row to
`src/lib/notifications/README.md`, and generates a stub integration test
at `src/lib/__tests__/notify-hr-document_expiring.test.ts`.
