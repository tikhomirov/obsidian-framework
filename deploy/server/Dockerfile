# Obsidian Framework server (coordinator + HTTP API + MCP).
# Build context: the .framework folder of the vault (see docker-compose.yml).
ARG BASE_IMAGE=node:24-bookworm-slim
FROM ${BASE_IMAGE} AS build
ARG NODE_TARBALL_VERSION=""
# Optional: base image with an older Node (e.g. a locally cached node:20-bookworm when Docker Hub is unreachable)
# + official Node tarball from nodejs.org, checked against SHASUMS256.
RUN if [ -n "$NODE_TARBALL_VERSION" ]; then set -e; cd /tmp; \
      f="node-v${NODE_TARBALL_VERSION}-linux-x64.tar.xz"; \
      curl -fsSLO "https://nodejs.org/dist/v${NODE_TARBALL_VERSION}/$f"; \
      curl -fsSL "https://nodejs.org/dist/v${NODE_TARBALL_VERSION}/SHASUMS256.txt" | grep " $f\$" | sha256sum -c -; \
      rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack; \
      tar -xJf "$f" -C /usr/local --strip-components=1 --no-same-owner; rm -f "$f"; node --version; fi
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund \
 && npx tsc -b packages/core/tsconfig.build.json packages/server/tsconfig.build.json \
 && npm prune --omit=dev --no-audit --no-fund

FROM ${BASE_IMAGE}
ARG PI_VERSION=1.4.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates tini curl xz-utils \
 && rm -rf /var/lib/apt/lists/*
ARG NODE_TARBALL_VERSION=""
# Optional: base image with an older Node (e.g. a locally cached node:20-bookworm when Docker Hub is unreachable)
# + official Node tarball from nodejs.org, checked against SHASUMS256.
RUN if [ -n "$NODE_TARBALL_VERSION" ]; then set -e; cd /tmp; \
      f="node-v${NODE_TARBALL_VERSION}-linux-x64.tar.xz"; \
      curl -fsSLO "https://nodejs.org/dist/v${NODE_TARBALL_VERSION}/$f"; \
      curl -fsSL "https://nodejs.org/dist/v${NODE_TARBALL_VERSION}/SHASUMS256.txt" | grep " $f\$" | sha256sum -c -; \
      rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack; \
      tar -xJf "$f" -C /usr/local --strip-components=1 --no-same-owner; rm -f "$f"; node --version; fi
RUN npm install -g --no-audit --no-fund "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm cache clean --force
WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/packages/core/package.json ./packages/core/package.json
COPY --from=build /src/packages/core/dist ./packages/core/dist
COPY --from=build /src/packages/server/package.json ./packages/server/package.json
COPY --from=build /src/packages/server/dist ./packages/server/dist
ENV NODE_ENV=production \
    HOME=/home/of \
    OF_HOST=0.0.0.0 \
    OF_PORT=8787 \
    OF_VAULT_DIR=/vault \
    OF_CLONES_DIR=/data/clones \
    OF_TOKENS_FILE=/config/tokens.json
# ssh needs a passwd entry for the runtime uid (compose: user PUID:PGID).
ARG PUID=1000
ARG PGID=1000
RUN mkdir -p /home/of /data && chmod 777 /home/of /data \
 && (getent group "$PGID" >/dev/null || groupadd -g "$PGID" of) \
 && (getent passwd "$PUID" >/dev/null || useradd -u "$PUID" -g "$PGID" -d /home/of -M -s /usr/sbin/nologin of)
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/server/dist/main.js"]
