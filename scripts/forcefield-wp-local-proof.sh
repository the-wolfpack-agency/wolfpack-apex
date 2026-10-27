#!/usr/bin/env bash
# Local WordPress proof for the Forcefield two-step onboarding.
#
#   bash scripts/forcefield-wp-local-proof.sh up      # throwaway WordPress + MySQL (official images)
#   bash scripts/forcefield-wp-local-proof.sh run     # the live Playwright journey against it
#   bash scripts/forcefield-wp-local-proof.sh down    # stop + remove the containers, network and volumes
#
# Needs: Docker running, and a local Instinct dev server on :3000 against a
# throwaway Postgres, started with
#   FORCEFIELD_DEV_SITE_ORIGINS=http://wp.localtest.me:8080   (lets the server reach the local site)
#   FORCEFIELD_MAIL_OUTBOX_DIR=<dir>                          (mail is written there, never sent)
# Both are ignored by a production build. wp.localtest.me resolves to loopback
# publicly, so no hosts-file edit is needed. Nothing here touches a deployed
# environment. Runbook: docs/forcefield/self-serve-onboarding.md.
set -euo pipefail

NET=ff-wp-proof
DB=ff-wp-proof-mysql
WP=ff-wp-proof-wordpress
PORT=8080
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
    wordpress:latest >/dev/null
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
  FF_WP_URL="${SITE_URL}" FF_WP_USER="${WP_USER}" \
    npx playwright test tests/e2e/forcefield-wordpress-live.spec.ts --reporter=list
}

down() {
  docker rm -f -v "$WP" "$DB" >/dev/null 2>&1 || true  # -v: their anonymous volumes only
  docker network rm "$NET" >/dev/null 2>&1 || true
  echo "removed ${WP}, ${DB}, ${NET}"
}

case "${1:-}" in
  up) up ;;
  run) run ;;
  down) down ;;
  *) echo "usage: $0 up|run|down" >&2; exit 2 ;;
esac
