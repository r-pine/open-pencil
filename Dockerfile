# syntax=docker/dockerfile:1.7
# Browser SPA for ci-nginx-proxy (shared-web + Let's Encrypt).
# Bun installs/builds packages; Node 22 runs Vite (config loads workspace .ts exports).

FROM oven/bun:1.3.14 AS bun

FROM node:22-bookworm AS build
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -sf /usr/local/bin/bun /usr/local/bin/bunx
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY packages ./packages
COPY tools ./tools
COPY src ./src
COPY vite ./vite
COPY assets ./assets
COPY public ./public
COPY index.html updater.html ./
COPY tsconfig.json tsconfig.node.json tsconfig.tests.json ./
COPY vite.config.ts ./

RUN bun install --frozen-lockfile \
  && bun run build:packages \
  && node ./node_modules/vite/bin/vite.js build

FROM nginx:alpine
COPY nginx-app/nginx.conf /etc/nginx/nginx.conf
COPY nginx-app/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/health >/dev/null || exit 1

CMD ["nginx", "-g", "daemon off;"]
