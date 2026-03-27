# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY assets ./assets

RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=10000 \
    HEXNEST_PYTHON_CMD=python3

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip tini ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages ddgs \
  && rm -f /usr/bin/curl /usr/bin/wget /usr/bin/nc /bin/nc /usr/bin/ping /bin/ping \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 hexnest \
  && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin hexnest

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=hexnest:hexnest /app/dist ./dist
COPY --from=build --chown=hexnest:hexnest /app/public ./public
COPY --from=build --chown=hexnest:hexnest /app/assets ./assets

USER hexnest
EXPOSE 10000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]
