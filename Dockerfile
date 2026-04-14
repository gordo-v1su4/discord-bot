FROM oven/bun:1-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src/ ./src/

EXPOSE 8080
ENV HEALTH_PORT=8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "const p=Number(process.env.HEALTH_PORT||process.env.PORT||8080);const r=await fetch('http://127.0.0.1:'+p+'/health');process.exit(r.ok?0:1)"
CMD ["bun", "src/index.js"]
