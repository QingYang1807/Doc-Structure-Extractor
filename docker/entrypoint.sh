#!/bin/sh
set -e

echo "[entrypoint] Waiting for PostgreSQL to be ready..."
until pg_isready -h "$(echo "$DATABASE_URL" | sed 's|.*@\([^:/]*\).*|\1|')" -U "$(echo "$DATABASE_URL" | sed 's|.*://\([^:]*\):.*|\1|')" 2>/dev/null; do
  sleep 1
done
echo "[entrypoint] PostgreSQL is ready."

echo "[entrypoint] Applying database schema..."
psql "$DATABASE_URL" -f /app/init.sql
echo "[entrypoint] Schema applied."

echo "[entrypoint] Starting API server..."
exec node --enable-source-maps /app/dist/index.mjs
