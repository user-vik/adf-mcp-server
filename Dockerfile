# syntax=docker/dockerfile:1.7
# Multi-stage build for adf-mcp-server.
# - builder stage installs prod deps so the runtime image has no dev cruft
# - runtime image is minimal, runs as a non-root user, no shell entrypoint
#
# Typical use: deploy to Azure Container Apps with a system-assigned managed
# identity, set ADF_AUTH_MODE=managed-identity, and grant the MI the relevant
# RBAC on the target Data Factory. See README → "Docker / managed identity".

FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runtime
WORKDIR /app

# Non-root user. node:20-alpine ships with a `node` user (uid 1000) but we
# create our own to avoid surprises across base-image upgrades.
RUN addgroup -S adf && adduser -S -G adf -h /app adf
COPY --from=builder --chown=adf:adf /app/node_modules ./node_modules
COPY --chown=adf:adf package.json index.js ./

USER adf
ENV NODE_ENV=production

# MCP speaks over stdio. The container is meant to be exec'd into by an MCP
# client process, not exposed on a port.
ENTRYPOINT ["node", "index.js"]
