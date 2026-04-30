FROM node:20-alpine

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Application source
COPY server.js worldStore.js codexRunner.js openaiAgent.js generationContract.js generationQualityGate.js glbInspector.js mcpClient.js ./
COPY config/ ./config/
COPY public/ ./public/
COPY scripts/ ./scripts/
COPY .env.example ./
COPY .gitignore ./

# Pre-built demo world — judges see real 3D models on first load
COPY demo-world.json ./world.json
COPY demo-assets/ ./assets/

ENV NODE_ENV=production
ENV FAKE_GENERATOR=1
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
