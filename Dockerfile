FROM node:24-bookworm-slim

# ExifTool powers the optional Google Takeout date/location merge.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libimage-exiftool-perl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts skips building better-sqlite3; the app then uses Node's built-in SQLite.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server.js access.js db.js tokens.js http.js settings.js meter.js ms.js google.js gsource.js takeout.js merge.js worker.js ./
COPY public ./public

# The database and temp copies of large files live on the /data volume.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/data/transfer.db \
    TMPDIR=/data/tmp \
    EXIFTOOL_PATH=exiftool
RUN mkdir -p /data/tmp && chown -R node:node /data
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
