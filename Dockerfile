# syntax=docker/dockerfile:1
#
# Ledgerly has no npm dependencies: it runs on Node's built-in HTTP server and SQLite,
# so the image is just Node plus the app's own files.

FROM node:24-alpine

LABEL org.opencontainers.image.title="Ledgerly" \
      org.opencontainers.image.description="Self-hosted earnings & expense tracker with multi-user accounts" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

# Run as the unprivileged "node" user (UID 1000). /data holds the SQLite database.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
