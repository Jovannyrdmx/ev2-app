FROM node:18-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install

FROM node:18-alpine

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:4000/health || exit 1

CMD ["node", "server.js"]
