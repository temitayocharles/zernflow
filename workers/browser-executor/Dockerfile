# Browser executor for Northflank Job 1 (free Sandbox job; never an always-on service).
# Build from the repository root so the shared adapter contracts in lib/browser are included:
#   docker build -f workers/browser-executor/Dockerfile -t zernflow-browser-executor .
# The Playwright image version MUST equal the pinned playwright-core version.
ARG PLAYWRIGHT_VERSION=1.63.0

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS build
WORKDIR /app
COPY workers/browser-executor/package.json workers/browser-executor/package-lock.json workers/browser-executor/
RUN npm ci --prefix workers/browser-executor --no-audit --no-fund
COPY lib/browser lib/browser
COPY workers/browser-executor/tsconfig.json workers/browser-executor/
COPY workers/browser-executor/src workers/browser-executor/src
RUN npm run build --prefix workers/browser-executor && npm prune --omit=dev --prefix workers/browser-executor

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/workers/browser-executor/node_modules workers/browser-executor/node_modules
COPY --from=build /app/workers/browser-executor/dist workers/browser-executor/dist
USER pwuser
CMD ["node", "workers/browser-executor/dist/workers/browser-executor/src/main.js"]
