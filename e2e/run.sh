#!/bin/sh
# Runs browser journeys end to end on a developer machine. Each journey gets a fresh embedded dev
# database, a new admin, the API on :4000 and the exported web app on :8099.
# Usage: sh e2e/run.sh [web-phase1.mjs web-phase2.mjs ...]   (default: all journeys)
# Development only. Never point this at a production database.
set -e
E2E="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$E2E")"
mkdir -p "$E2E/.out"
JOURNEYS="${*:-web-phase1.mjs web-phase2.mjs web-phase3.mjs web-phase4.mjs web-phase5.mjs web-phase6.mjs web-phase7.mjs web-faculties.mjs}"

stop_port() {
  if command -v powershell.exe >/dev/null 2>&1; then
    powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort $1 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force }" || true
  else
    (lsof -ti tcp:"$1" | xargs -r kill) || true
  fi
}
stop_port 4000; stop_port 8099; sleep 1

echo "Building web app..."
(cd "$ROOT" && CI=1 npx expo export --platform web --output-dir dist >/dev/null)
# Single-page hosting: unknown paths fall back to index.html, as production hosting must.
(node "$E2E/spa-server.mjs" "$ROOT/dist" 8099 > "$E2E/.out/web.log" 2>&1 &)

status=0
for journey in $JOURNEYS; do
  echo "=== $journey ==="
  stop_port 4000; sleep 1
  cd "$ROOT/server"
  export PGLITE_DATA_DIR=.data/e2e NODE_ENV=development
  rm -rf .data/e2e
  npm run -s seed-dev >/dev/null
  npm run -s create-admin -- --email admin@university.example --name "E2E Admin" > "$E2E/.out/admin.txt"
  (PORT=4000 LOG_LEVEL=warn CORS_ORIGINS=http://localhost:8099 PUBLIC_APP_URL=http://localhost:8099 node src/main.ts > "$E2E/.out/api.log" 2>&1 &)
  for i in $(seq 1 60); do
    curl -s localhost:4000/health >/dev/null && curl -s -o /dev/null localhost:8099/sign-in && break
    sleep 1
  done
  (cd "$E2E" && node "$journey") || status=1
done

stop_port 4000; stop_port 8099
exit $status
