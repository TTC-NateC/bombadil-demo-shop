# specs/01 §10. Single container, no external services.
#
# node:20-slim, NOT alpine: Prisma's musl query-engine binary is the most common
# Next+Prisma container failure and it only surfaces on someone else's machine.
# Debian's glibc/openssl3 removes that class of bug for ~40MB.

# ---- deps -------------------------------------------------------------------
FROM node:20-slim AS deps
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ------------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The datasource block reads env("DATABASE_URL"); nothing connects at build
# time, but the variable must resolve.
ENV DATABASE_URL="file:/tmp/build.db"
# public/ must exist or the runner's COPY fails outright.
RUN mkdir -p public && npx prisma generate && npm run build

# ---- runtime deps -----------------------------------------------------------
# `prisma` and `tsx` are needed AT RUNTIME (migrate deploy, and the seed is
# TypeScript). Next's standalone tracing does not include them, and resolving
# them with bare `npx` at container start would require network access at boot
# and pull an unpinned version. Install them here, with their own transitive
# deps, and copy the tree in.
FROM node:20-slim AS runtimedeps
WORKDIR /rt
# Read the versions BEFORE npm init, which would otherwise overwrite this file
# with a default and silently drop the pins.
COPY package.json /tmp/app-package.json
RUN PRISMA_VERSION="$(node -p "require('/tmp/app-package.json').dependencies.prisma")" \
 && TSX_VERSION="$(node -p "require('/tmp/app-package.json').dependencies.tsx")" \
 && npm init -y >/dev/null \
 && npm install --omit=dev --no-audit --no-fund \
      "prisma@${PRISMA_VERSION}" "tsx@${TSX_VERSION}"

# ---- runner -----------------------------------------------------------------
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Defaults so `docker run -p 3000:3000 -v cartdata:/data demo-cart` works with
# no env beyond ADMIN_API_KEY (specs/01 §10). .env is .dockerignore'd, so
# nothing else supplies these.
ENV DATABASE_URL="file:/data/app.db"
ENV UPLOAD_DIR="/data/uploads"
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Next standalone output
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public

# Prisma query engine — standalone tracing routinely misses this.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma

# prisma CLI + tsx and their transitive deps (merged into the same node_modules)
COPY --from=runtimedeps /rt/node_modules ./node_modules

# Schema, migrations, seed, and the package.json carrying the prisma.seed key
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

VOLUME /data
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
