# The public demo: the scripted stand-in model, so it runs with no API key and costs nothing.
# Never pass a provider key to a public deployment: every visitor would spend it.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV BLACKBOX_MODE=scripted
EXPOSE 8787
# A host that assigns a port sets PORT; the engine reads ENGINE_PORT.
CMD ["sh", "-c", "ENGINE_PORT=${PORT:-8787} exec npx tsx server/index.ts"]
