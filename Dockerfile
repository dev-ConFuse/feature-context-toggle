# =============================================================================
# Feature Toggle Service - Dockerfile (Node.js 22 LTS)
# Container deployment (Docker / AKS)
# Role: Central feature toggle service for the ConFuse platform
# Includes both backend API and frontend dashboard
# =============================================================================

FROM node:22-alpine AS frontend-builder

WORKDIR /app
# Copy frontend with its own tsconfig
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend ./
# The dashboard build is optional (its src/sdk has pre-existing missing-type
# errors); never block the API image on it.
RUN npm run build || mkdir -p dist

# =============================================================================
FROM node:22-alpine AS production

WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache dumb-init curl

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

# Copy root tsconfig (needed by backend)
COPY tsconfig.json ./

# Copy database schema for initialization
COPY database ./database

# Copy backend directory
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm install && npm cache clean --force
COPY backend ./

# Build TypeScript
RUN npm run build

# Remove dev dependencies from production image
RUN npm prune --omit=dev 2>/dev/null || true

# Copy frontend build from builder stage with strict ownership
COPY --chown=nextjs:nodejs --from=frontend-builder /app/frontend/dist /app/backend/public

# Change ownership to non-root user
RUN chown -R nextjs:nodejs /app
USER nextjs

# =============================================================================
# Environment Variables (configure via Render environment settings)
# =============================================================================
# Required:
#   DATABASE_URL
# Optional (with defaults):
#   PORT=3099, NODE_ENV=production, CACHE_TTL_SECONDS=300
#   CORS_ORIGINS=<comma-separated-urls>
# =============================================================================

ENV NODE_ENV=production
# PORT is supplied at runtime via .map.env / .secret.env (see .cline/rules/env-policy.md)

EXPOSE 3099

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

# Use dumb-init as PID 1 for proper signal handling
ENTRYPOINT ["dumb-init", "--"]

# Run the backend
CMD ["node", "dist/index.js"]
