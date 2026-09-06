# syntax=docker/dockerfile:1

# Keep the build and runtime on the package manager recorded by the repository's
# committed package-lock.json. This makes local, CI, and container installs use
# the same dependency graph.
ARG NODE_VERSION=24.13.0-slim
ARG MAINTAINFLOW_BUILD_SHA=""

FROM node:${NODE_VERSION} AS dependencies

# Set working directory
WORKDIR /app

# Copy package-related files first to leverage Docker's caching mechanism.
COPY package.json package-lock.json .npmrc* ./
COPY patches ./patches

# Install the exact dependency graph from package-lock.json.
RUN --mount=type=cache,target=/root/.npm npm ci

# ============================================
# Stage 2: Build Next.js application in standalone mode
# ============================================

FROM node:${NODE_VERSION} AS builder

# Set working directory
WORKDIR /app

# Next.js inlines NEXT_PUBLIC values into the browser bundle at build time.
# The Supabase publishable key is public, but must match the runtime Supabase tenant.
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=""
ARG NEXT_PUBLIC_SUPABASE_URL=""
ARG MAINTAINFLOW_BUILD_SHA=""
ARG MAINTAINCODE_APP_ORIGIN="https://maintainflow.io"
ENV MAINTAINCODE_APP_ORIGIN=${MAINTAINCODE_APP_ORIGIN}
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY}
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
ENV MAINTAINFLOW_BUILD_SHA=${MAINTAINFLOW_BUILD_SHA}

# Copy project dependencies from dependencies stage
COPY --from=dependencies /app/node_modules ./node_modules

# Copy application source code
COPY . .

ENV NODE_ENV=production

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the build.
# ENV NEXT_TELEMETRY_DISABLED=1

# Build Next.js application
# If you want to speed up Docker rebuilds, you can cache the build artifacts
# by adding: --mount=type=cache,target=/app/.next/cache
# This caches the .next/cache directory across builds, but it also prevents
# .next/cache/fetch-cache from being included in the final image, meaning
# cached fetch responses from the build won't be available at runtime.
RUN npm run build

# ============================================
# Stage 3: Run Next.js application
# ============================================

FROM node:${NODE_VERSION} AS runner

# Set working directory
WORKDIR /app

# Set production environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Preserve the same public Supabase configuration used to compile the browser
# bundle. Secret Supabase and provider credentials are supplied only at runtime.
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=""
ARG NEXT_PUBLIC_SUPABASE_URL=""
ARG MAINTAINFLOW_BUILD_SHA
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY}
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}

LABEL org.opencontainers.image.revision=${MAINTAINFLOW_BUILD_SHA}

# Next.js collects completely anonymous telemetry data about general usage.
# Learn more here: https://nextjs.org/telemetry
# Uncomment the following line in case you want to disable telemetry during the run time.
# ENV NEXT_TELEMETRY_DISABLED=1

# Copy production assets
COPY --from=builder --chown=node:node /app/public ./public

# Set the correct permission for prerender cache
RUN mkdir .next
RUN chown node:node .next

# Automatically leverage output traces to reduce image size
# https://nextjs.org/docs/advanced-features/output-file-tracing
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/.next/maintainflow-public-build-metadata.json ./.next/maintainflow-public-build-metadata.json
COPY --from=builder --chown=node:node /app/scripts/check-maintaincode-config.mjs ./scripts/check-maintaincode-config.mjs
COPY --from=builder --chown=node:node /app/scripts/database-tls.mjs ./scripts/database-tls.mjs
COPY --from=builder --chown=node:node /app/scripts/public-build-metadata.mjs ./scripts/public-build-metadata.mjs
COPY --from=builder --chown=node:node /app/scripts/start-standalone-production.mjs ./scripts/start-standalone-production.mjs

# If you want to persist the fetch cache generated during the build so that
# cached responses are available immediately on startup, uncomment this line:
# COPY --from=builder --chown=node:node /app/.next/cache ./.next/cache

# Switch to non-root user for security best practices
USER node

# Expose port 3000 to allow HTTP traffic
EXPOSE 3000

# Process liveness only. Provider, database, and release readiness remain
# separate deployment gates and are not inferred from this endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

# Refuse to start with a partial or contradictory production configuration.
CMD ["node", "scripts/start-standalone-production.mjs"]
