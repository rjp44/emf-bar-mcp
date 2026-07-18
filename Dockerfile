# Small, production-ready image for the EMF bar MCP server.
FROM node:20-alpine

ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    PORT=8787

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src

EXPOSE 8787

# Warms the catalog on boot; container is ready once /healthz reports ok.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8787/healthz | grep -q '"ok":true' || exit 1

USER node
CMD ["node", "src/index.js"]
