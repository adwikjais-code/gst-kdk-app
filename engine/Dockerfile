# KDK GST Engine — live mode image (Playwright + headless Chromium)
# Render auto-detects this Dockerfile (Root Directory = engine) and
# builds this image — no need to set a Build Command.
FROM node:20-slim

ENV NODE_ENV=production
WORKDIR /app

# install node deps (includes playwright optional dep)
COPY package.json package-lock.json ./
RUN npm install

# app code
COPY . .

# browser + system deps (we are root inside Docker, so --with-deps works)
RUN npx playwright install --with-deps chromium --only-shell

EXPOSE 10000
CMD ["node", "server.js"]
