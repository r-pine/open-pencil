# syntax=docker/dockerfile:1.7
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV PORT=8787
EXPOSE 8787
USER node
CMD ["node", "src/server.js"]
