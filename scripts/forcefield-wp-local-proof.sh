#!/usr/bin/env bash
# Local WordPress proof for the Forcefield two-step onboarding.
#
#   bash scripts/forcefield-wp-local-proof.sh up      # throwaway WordPress + MySQL (official images)
#   bash scripts/forcefield-wp-local-proof.sh run     # the live Playwright journey against it
#   bash scripts/forcefield-wp-local-proof.sh down    # stop + remove the containers, network and volumes
#
# Which WordPress image, and on which port (defaults: wordpress:latest on 8080):
#   FF_WP_IMAGE=wordpress:php8.1-apache FF_WP_PORT=8081 bash scripts/forcefield-wp-local-proof.sh up
# Containers are named per port, so two proofs never collide. FF_EXPECT_EXPOSURE
# (exposed | ok) on `run` asserts the dashboard's "Is your server exposed?"
# panel for that image's PHP: e.g. php8.1 (no longer supported) is exposed.
#
# Needs: Docker running, and a local Instinct dev server on :3000 against a
# throwaway Postgres, started with
#   FORCEFIELD_DEV_SITE_ORIGINS=http://wp.localtest.me:8080   (lets the server reach the local site;
#                                                            comma-separate one origin per port)
#   FORCEFIELD_MAIL_OUTBOX_DIR=<dir>                          (mail is written there, never sent)
#   INSTINCT_PUBLIC_URL=http://localhost:3000                (links in that mail point at the local
#                                                            server; unset, they point at production)
# The app always connects with sslmode=verify-full, so the throwaway Postgres
# must serve TLS (e.g. postgres -c ssl=on with a self-signed cert for
# "localhost", trusted through NODE_EXTRA_CA_CERTS, DATABASE_URL on localhost).
# Both are ignored by a production build. wp.localtest.me resolves to loopback
# publicly, so no hosts-file edit is needed. Nothing here touches a deployed
# environment. Runbook: docs/forcefield/self-serve-onboarding.md.
set -euo pipefail

PORT="${FF_WP_PORT:-8080}"
IMAGE="${FF_WP_IMAGE:-wordpress:latest}"
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || { echo "FF_WP_PORT must be a port number" >&2; exit 2; }
[[ "$IMAGE" =~ ^wordpress(:[A-Za-z0-9._-]+)?$ ]] || { echo "FF_WP_IMAGE must be an official wordpress image (wordpress:<tag>)" >&2; exit 2; }
NET="ff-wp-proof-${PORT}"
DB="ff-wp-proof-mysql-${PORT}"
WP="ff-wp-proof-wordpress-${PORT}"
SITE_URL="http://wp.localtest.me:${PORT}"
WP_USER="${FF_WP_USER:-ffadmin}"
WP_PASS="${FF_WP_PASS:-ff-local-proof-$(date +%s)}"
INGEST="${FF_INGEST:-http://host.docker.internal:3000/api/forcefield/observe}"

up() {
  docker network create "$NET" >/dev/null 2>&1 || true
  docker run -d --name "$DB" --network "$NET" \
    -e MYSQL_DATABASE=wordpress -e MYSQL_USER=wp -e MYSQL_PASSWORD=wp -e MYSQL_RANDOM_ROOT_PASSWORD=1 \
    mysql:8.4 >/dev/null
  docker run -d --name "$WP" --network "$NET" -p "${PORT}:80" \
    --add-host=host.docker.internal:host-gateway \
    -e WORDPRESS_DB_HOST="$DB" -e WORDPRESS_DB_USER=wp -e WORDPRESS_DB_PASSWORD=wp -e WORDPRESS_DB_NAME=wordpress \
    -e WORDPRESS_CONFIG_EXTRA="define('WP_HOME','${SITE_URL}'); define('WP_SITEURL','${SITE_URL}'); define('OGIAM_FF_DEFAULT_INGEST','${INGEST}');" \
    "$IMAGE" >/dev/null
  echo "waiting for WordPress..."
  for _ in $(seq 1 90); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "${SITE_URL}/wp-admin/install.php" || true)
    [[ "$code" == "200" ]] && break
    sleep 2
  done
  # Run the installer once (the same form a person fills in).
  curl -s -o /dev/null "${SITE_URL}/wp-admin/install.php?step=2" \
    --data-urlencode "weblog_title=Forcefield local proof" --data-urlencode "user_name=${WP_USER}" \
    --data-urlencode "admin_password=${WP_PASS}" --data-urlencode "admin_password2=${WP_PASS}" \
    --data-urlencode "pw_weak=on" --data-urlencode "admin_email=${FF_EMAIL:-forcefield-wp-proof@thewolfpack.agency}" \
    --data-urlencode "blog_public=0" --data-urlencode "language="
  docker exec "$WP" php -v | head -1
  docker exec "$WP" php -r 'require "/var/www/html/wp-includes/version.php"; echo "WordPress $wp_version\n";'
  echo "FF_WP_URL=${SITE_URL} FF_WP_USER=${WP_USER} FF_WP_PASS=${WP_PASS}"
}

run() {
  : "${FF_WP_PASS:?set FF_WP_PASS (printed by up)}" "${FF_OUTBOX_DIR:?set FF_OUTBOX_DIR to the dev server outbox}"
  FF_WP_URL="${SITE_URL}" FF_WP_USER="${WP_USER}" FF_EXPECT_EXPOSURE="${FF_EXPECT_EXPOSURE:-}" \
    npx playwright test tests/e2e/forcefield-wordpress-live.spec.ts --reporter=list
}

down() {
  docker rm -f -v "$WP" "$DB" >/dev/null 2>&1 || true  # -v: their anonymous volumes only
  docker network rm "$NET" >/dev/null 2>&1 || true
  echo "removed ${WP}, ${DB}, ${NET} (image ${IMAGE} kept; docker image prune to reclaim)"
}

case "${1:-}" in
  up) up ;;
  run) run ;;
  down) down ;;
  *) echo "usage: $0 up|run|down" >&2; exit 2 ;;
esac
