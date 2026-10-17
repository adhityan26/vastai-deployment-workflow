# syntax=docker/dockerfile:1
# Build context is the REPOSITORY ROOT:
#   docker build -f apps/web/Dockerfile -t vast-comfy-web .
# Base image: Node 24 (current LTS line, matches @types/node ^24) on Alpine. Alpine keeps the
# image small and the app has no native dependencies. The tag is a moving minor tag on purpose
# (security patches); pin a digest in your own build if you need bit-exact images.

FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/core/package.json apps/core/tsconfig.json apps/core/tsconfig.build.json apps/core/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/tsconfig.page.json apps/web/tsconfig.build.json apps/web/
RUN npm ci
COPY apps/core/src apps/core/src
COPY apps/web/src apps/web/src
COPY apps/web/public apps/web/public
RUN npm run build
# For production the workspace package must resolve to its compiled output. In the source tree
# "main" points at src/index.ts (type-check and Vitest run on sources), so repoint it here only.
RUN node -e 'const fs=require("fs");const p="apps/core/package.json";const j=JSON.parse(fs.readFileSync(p,"utf8"));j.main="dist/index.js";j.types="dist/index.d.ts";fs.writeFileSync(p,JSON.stringify(j,null,2))'

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /repo/apps/core/package.json apps/core/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /repo/apps/core/dist apps/core/dist
COPY --from=build /repo/apps/web/dist apps/web/dist
# Static page: index.html, CSS and the bundled app.js (the TypeScript source is not shipped).
COPY --from=build /repo/apps/web/public/index.html /repo/apps/web/public/style.css /repo/apps/web/public/icon.svg /repo/apps/web/public/manifest.webmanifest /repo/apps/web/public/app.js apps/web/public/
# Only the contracts and instance files the process reads. main.js resolves ../../../contracts
# from apps/web/dist, and WEB_REPO_DIR defaults to "." (the WORKDIR).
COPY contracts/config-schema.yaml contracts/instance-registry.schema.json contracts/status.schema.json contracts/
COPY instance/profiles instance/profiles
COPY instance/workflows instance/workflows
# Registry volume mount point, writable by the unprivileged user.
RUN mkdir -p /data && chown node:node /data
# Non-root from here on; nothing is installed after this line.
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/web/dist/main.js"]
