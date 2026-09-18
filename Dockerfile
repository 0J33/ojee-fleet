FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY ui ./ui
COPY public ./public
COPY config ./config

ENV NODE_ENV=production PORT=8400
EXPOSE 8400

# Health is about THIS service, not about the machines it watches — a host
# being down is information the module is successfully reporting.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8400)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
