# Build from the repo root: docker build -f apps/api/Dockerfile .
# Phase 0 stub: installs only this workspace's dependency closure and runs the TypeScript source with bun.
FROM oven/bun:1.4 AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY apps/mobile/package.json apps/mobile/package.json
COPY apps/mobile/patches apps/mobile/patches
COPY apps/api/package.json apps/api/package.json
COPY apps/mock-world/package.json apps/mock-world/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile --filter '@kassa/api'

FROM oven/bun:1.4
WORKDIR /app
ENV NODE_ENV=production PORT=4000
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bunfig.toml tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
WORKDIR /app/apps/api
EXPOSE 4000
USER bun
CMD ["bun", "src/index.ts"]
