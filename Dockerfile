ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build --if-present
RUN npm prune --omit=dev

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
CMD ["npm", "start"]
