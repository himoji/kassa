# Build from the repo root: docker build -f apps/mock-world/Dockerfile .
# Phase 0 stub: installs only this workspace's dependency closure and runs the TypeScript source with bun.
FROM oven/bun:1.4 AS deps
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY apps/mobile/package.json apps/mobile/package.json
COPY apps/mobile/patches apps/mobile/patches
COPY apps/api/package.json apps/api/package.json
COPY apps/mock-world/package.json apps/mock-world/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile --filter '@kassa/mock-world'

FROM oven/bun:1.4
WORKDIR /app
ENV NODE_ENV=production PORT=4001
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bunfig.toml tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/mock-world apps/mock-world
WORKDIR /app/apps/mock-world
EXPOSE 4001
USER bun
CMD ["bun", "src/index.ts"]
