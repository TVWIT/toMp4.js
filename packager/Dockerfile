# OTFP-compatible HLS packager.
# Build from the repo root (the packager imports ../src):
#   docker build -f packager/Dockerfile -t tomp4-packager .
#   docker run --rm -p 8080:8080 tomp4-packager
FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app

# Zero runtime dependencies: the library source and the server are enough.
COPY package.json ./
COPY src ./src
COPY packager ./packager

USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/healthz" || exit 1

CMD ["node", "packager/server.js"]
