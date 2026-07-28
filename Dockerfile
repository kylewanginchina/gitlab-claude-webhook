FROM node:20-alpine

# Install shell and repository tooling used by review/edit workflows
RUN apk add --no-cache bash git curl ripgrep su-exec

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./
COPY frontend/package*.json ./frontend/
COPY frontend/tsconfig.json ./frontend/
COPY frontend/vite.config.ts ./frontend/
COPY frontend/index.html ./frontend/

# Install dependencies (skip prepare script to avoid premature build)
RUN npm ci --ignore-scripts
RUN npm --prefix frontend ci --ignore-scripts

# Copy source code and .env.example
COPY src/ ./src/
COPY frontend/src/ ./frontend/src/
COPY .env.example ./

# Build the application
RUN npm run build:server
RUN npm --prefix frontend run build

# Remove dev dependencies after build
RUN npm prune --omit=dev
RUN npm --prefix frontend prune --omit=dev

# Create writable runtime directories
RUN mkdir -p /tmp/gitlab-claude-work /app/data /app/logs

# Create non-root user
RUN addgroup -g 1001 -S claude && \
    adduser -S claude -u 1001

# Create .codex directory for the user
RUN mkdir -p /home/claude/.codex && \
    chown -R claude:claude /home/claude/.codex

# Change ownership of writable runtime directories only. Application files remain
# root-owned but readable, which avoids a slow recursive chown over node_modules.
RUN chown -R claude:claude /tmp/gitlab-claude-work /app/data /app/logs

# Set HOME environment for the claude user
ENV HOME=/home/claude
ENV DATA_DIR=/app/data
ENV LOG_DIR=/app/logs

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const port = process.env.PORT || 3000; require('http').get(`http://localhost:${port}/health`, (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
