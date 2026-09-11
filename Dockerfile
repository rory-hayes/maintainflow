# syntax=docker/dockerfile:1
ARG NODE_VERSION=24.13.0-bookworm-slim

FROM node:${NODE_VERSION} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:${NODE_VERSION} AS runtime
ARG MAINTAINFLOW_BUILD_SHA=unrecorded
LABEL org.opencontainers.image.revision=${MAINTAINFLOW_BUILD_SHA}
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4318 STORAGE_DIR=/var/lib/maintainflow/files
WORKDIR /app

# The current server and decoder execute TypeScript through tsx. Keep the exact
# locked dependency graph, including that runtime loader, in this image.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json /app/tsconfig.json ./
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/scripts/migrate.ts ./scripts/migrate.ts
RUN mkdir -p /var/lib/maintainflow/files && chown node:node /var/lib/maintainflow/files && chmod 700 /var/lib/maintainflow/files
USER node
EXPOSE 4318
# Process liveness only. Database, storage and worker acceptance are separate.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4318/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "server/app.ts"]
