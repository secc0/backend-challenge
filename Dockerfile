FROM oven/bun:1.4.4-alpine
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["bun", "src/main.ts"]
