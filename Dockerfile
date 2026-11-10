# syntax=docker/dockerfile:1
#
# dlhd-bridge — Node.js 22, zero runtime dependencies, non-root, read-only friendly.
# The healthcheck uses the bundled Node fetch, so no curl/wget is installed.

FROM node:22.20-alpine

# Keep runtime behaviour production-like and skip dev-only installs.
ENV NODE_ENV=production

WORKDIR /app

# Install first so the (empty) dependency layer is cached independently of src/.
# The project has zero runtime dependencies; the lockfile is a valid v3 lockfile.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --chown=node:node src ./src

ENV PORT=8080
EXPOSE 8080

# The image ships an unprivileged `node` user (uid/gid 1000).
USER node

# /healthz answers 200 as soon as the HTTP server is up; `ok:true` additionally
# means the first catalogue scrape has completed (see README).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

STOPSIGNAL SIGTERM

CMD ["node", "src/index.js"]
