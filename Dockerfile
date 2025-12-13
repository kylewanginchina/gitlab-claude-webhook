FROM node:20-alpine

# Install git, curl and other dependencies
RUN apk add --no-cache git curl

# Install Claude Code CLI and OpenAI Codex CLI globally
RUN npm install -g @anthropic-ai/claude-code @openai/codex --registry=https://registry.npmmirror.com

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies (skip prepare script to avoid premature build)
RUN npm ci --ignore-scripts

# Copy source code and .env.example
COPY src/ ./src/
COPY .env.example ./

# Build the application
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --omit=dev

# Create work directory
RUN mkdir -p /tmp/gitlab-claude-work

# Create non-root user
RUN addgroup -g 1001 -S claude && \
    adduser -S claude -u 1001

# Create .codex directory for the user
RUN mkdir -p /home/claude/.codex && \
    chown -R claude:claude /home/claude/.codex

# Change ownership of work directory
RUN chown -R claude:claude /tmp/gitlab-claude-work /app

# Switch to non-root user
USER claude

# Set HOME environment for the claude user
ENV HOME=/home/claude

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# Start the application (config.toml is generated at startup by the app)
CMD ["node", "dist/index.js"]
