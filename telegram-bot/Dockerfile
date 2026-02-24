FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY bot.ts tsconfig.json ./

# tsx runs TypeScript directly — no separate compile step
CMD ["node", "node_modules/.bin/tsx", "bot.ts"]
