#!/bin/sh
# specs/01 §10, specs/02 §2.1 and §8.4.
#
# Amended by Phase 7 (admin key startup refusal) and Phase 8 (uploads dir).
set -e

# --- Phase 7 / specs-02 §2.1: fail closed on a missing or default admin key ---
if [ "$NODE_ENV" = "production" ]; then
  case "$ADMIN_API_KEY" in
    ""|"change-me")
      echo "FATAL: ADMIN_API_KEY must be set to a non-default value." >&2
      exit 1
      ;;
  esac
fi

# --- Phase 2 / Phase 8: writable state on the mounted volume -----------------
mkdir -p /data
mkdir -p "${UPLOAD_DIR:-/data/uploads}"

# --- Schema and baseline data ------------------------------------------------
# --no-install: fail loudly rather than reaching for the network at boot.
npx --no-install prisma migrate deploy
npx --no-install prisma db seed

exec node server.js
