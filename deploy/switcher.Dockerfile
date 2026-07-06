# Switcher image — the second deployable in this repo (the daemon stays
# systemd on the tvh hosts: it needs QSV hardware + the local serveDir; the
# switcher is plain HTTP and runs on Kubernetes, outside the tvh-location
# failure domains).
#
# Build (repo root): docker build -f deploy/switcher.Dockerfile -t restreamer-switcher .

FROM node:22-alpine AS build
RUN npm install -g pnpm@9.15.1
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-alpine AS deps
RUN npm install -g pnpm@9.15.1
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    SWITCHER_CONFIG=/etc/restreamer/switcher.yaml
COPY --from=deps /app/node_modules ./node_modules
# package.json is required at runtime: dist/version.js reads ../package.json
COPY package.json ./
COPY --from=build /app/dist ./dist
EXPOSE 5590
USER node
CMD ["node", "dist/switcher/main.js"]
