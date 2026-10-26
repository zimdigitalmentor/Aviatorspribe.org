# Aviator Tracker: PWA + /api in one container. Database runs separately (docker-compose.yml or managed Postgres).
FROM node:22-alpine

ENV NODE_ENV=production PORT=5173
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY server ./server
COPY scripts ./scripts
COPY public ./public

USER node
EXPOSE 5173
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/plans').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
