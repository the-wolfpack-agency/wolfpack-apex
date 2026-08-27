#!/usr/bin/env bash
# Run the *.db.test.ts suites against a THROWAWAY local Postgres.
#
# WHY THIS SCRIPT EXISTS. On 2026-08-26 a schema-building test was run with
# TEST_DATABASE_URL pointed at the production DATABASE_URL, because the command
# line was reused from a previous version of the same file that only read
# information_schema. It dropped instinct_ms_tokens. requireLocalTestDatabase()
# now refuses a non-local host, but the second half of the fix is that nobody
# should be hand-typing a connection string for this at all.
#
# So: this owns the container, owns the URL, and the URL is local by
# construction. There is nothing to point at the wrong database.
#
#   npm run test:db              # all db suites
#   npm run test:db -- audience  # jest pattern
#
# The container is disposable and is removed on exit. It listens on a port
# chosen to avoid the other local Postgres containers on this machine.
set -euo pipefail

NAME="apex-db-test"
PORT="${APEX_DB_TEST_PORT:-55998}"
IMAGE="postgres:16-alpine"
URL="postgres://postgres:test@127.0.0.1:${PORT}/apextest"

if ! command -v docker >/dev/null 2>&1; then
  echo "[db-test] docker is not available. These suites need a throwaway Postgres."
  echo "[db-test] They SKIP without TEST_DATABASE_URL rather than failing, so a"
  echo "[db-test] machine without docker is not blocked, but it also is not"
  echo "[db-test] running them. That distinction is the point of this message."
  exit 0
fi

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

echo "[db-test] starting throwaway postgres on ${PORT}"
docker run -d --name "$NAME" \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=apextest \
  -p "${PORT}:5432" "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 || {
  echo "[db-test] postgres never became ready"; exit 1;
}

echo "[db-test] running db suites"
TEST_DATABASE_URL="$URL" npx jest --testPathPatterns='\.db\.test\.ts$' "$@"
