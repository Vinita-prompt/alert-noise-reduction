FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    NODE_EXTRA_CA_CERTS=/app/ABCFSROOTCA.pem

WORKDIR /app

COPY package.json package-lock.json ./
COPY ml/requirements-shadow.txt ./ml/requirements-shadow.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip libgomp1 \
    && pip3 install --no-cache-dir --break-system-packages -r ml/requirements-shadow.txt \
    && npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force \
    && rm -rf /var/lib/apt/lists/*

COPY ABCFSROOTCA.pem ./ABCFSROOTCA.pem
COPY src ./src
COPY scripts ./scripts
COPY ml ./ml
RUN mkdir -p /app/data/evidence-attachments /app/data/ml-artifacts \
    && chown -R node:node /app/data

USER node

EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["sh", "-c", "npm run db:migrate && npm start"]
