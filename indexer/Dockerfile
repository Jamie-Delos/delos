FROM node:20-slim
# Prisma needs openssl at runtime.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npx prisma generate && npm run build

EXPOSE 8080
# Applies pending migrations, then starts the API + ingester.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
