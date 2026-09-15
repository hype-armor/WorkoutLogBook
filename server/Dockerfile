# One image: the app and the API from a single origin, which is what removes
# CORS and leaves a self-hoster with one thing to run.
#
# No build stage, because there is nothing to build. The server has no
# dependencies — node:sqlite and node:http — and the app is one HTML file. A
# multi-stage Dockerfile here would be ceremony around a copy.
FROM node:22-alpine

# No init process. The usual reason for one is that PID 1 ignores signals whose
# disposition is the default — but node is not PID 1 by accident here, it
# installs a SIGTERM handler and drains on it. The other reason is reaping
# orphaned children, and this server starts none. So: no extra layer, and
# nothing between the orchestrator and the process it is signalling.
WORKDIR /app

# The app, exactly as the service worker precaches it and the static handler
# allows. Nothing else from the repository is in here.
COPY index.html sw.js manifest.webmanifest version.txt ./
COPY icon-192.png icon-512.png icon-maskable-512.png apple-touch-icon.png favicon-32.png ./
COPY img/ ./img/

# The server. package.json carries no dependencies; it is here so that `type:
# module` is in force and the version is legible from inside the image.
COPY server/package.json ./server/package.json
COPY server/src/ ./server/src/

# Owned by the unprivileged user the image already has, so the database
# directory is writable with a read-only root filesystem everywhere else.
RUN mkdir -p /data && chown -R node:node /data

ENV NODE_ENV=production \
    LOGBOOK_PORT=8080 \
    LOGBOOK_DB=/data/logbook.db \
    LOGBOOK_SERVE_STATIC=true \
    LOGBOOK_OPEN_REGISTRATION=false

EXPOSE 8080
VOLUME ["/data"]
USER node

# No curl in this image, and no reason to add one: node can ask.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LOGBOOK_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Exec form and an absolute path: exec form so the signal reaches node rather
# than a shell, absolute so the entry point does not depend on the working
# directory — the module only runs itself when argv[1] resolves to this file.
ENTRYPOINT ["node", "/app/server/src/index.js"]
