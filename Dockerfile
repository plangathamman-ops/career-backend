FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
# Use `npm ci` when a lockfile exists for reproducible installs; otherwise
# fall back to `npm install` so builds don't fail when the lockfile isn't
# present in the build context (e.g. when building from a different repo root).
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev || npm install --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

COPY . .

ENV NODE_ENV=production
ENV PORT=5000

EXPOSE 5000

CMD ["node", "src/index.js"]

