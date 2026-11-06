# syntax=docker/dockerfile:1
# Generated from @selfbuilding/images. Do not edit by hand.
ARG BASE_IMAGE=selfbuilding/base:0.1.0
FROM $BASE_IMAGE
USER root
SHELL ["/bin/sh", "-euc"]
RUN npm --userconfig=/dev/null --ignore-scripts=false install --global --prefix /usr/local @openai/codex@0.166.0
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/selfbuilding/browsers NODE_PATH=/usr/local/lib/node_modules
RUN apt-get update \
  && apt-get install -y --no-install-recommends sqlite3 \
  && npm --userconfig=/dev/null --ignore-scripts=false install --global --prefix /usr/local playwright@1.64.1 @playwright/mcp@0.0.83 \
  && /usr/local/bin/playwright install --with-deps chromium \
  && node /usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright-core/cli.js install chromium \
  && rm -rf /var/lib/apt/lists/* \
  && chmod -R a+rX /opt/selfbuilding/browsers
RUN rm -f /usr/local/bin/playwright-mcp \
  && printf '#!/bin/sh\n: "${PLAYWRIGHT_BROWSERS_PATH:=/opt/selfbuilding/browsers}"\nexport PLAYWRIGHT_BROWSERS_PATH\nexec node /usr/local/lib/node_modules/@playwright/mcp/cli.js "$@"\n' > /usr/local/bin/playwright-mcp \
  && chmod 0755 /usr/local/bin/playwright-mcp \
  && mkdir -p /selfbuilding/node_modules \
  && ln -sfn /usr/local/lib/node_modules/playwright /selfbuilding/node_modules/playwright \
  && mkdir -p /selfbuilding/home/.cache/ms-playwright \
  && cp -as /opt/selfbuilding/browsers/. /selfbuilding/home/.cache/ms-playwright/ \
  && chown -R -h agent:agent /selfbuilding/home/.cache \
  && mkdir -p /home/agent/.cache/ms-playwright \
  && cp -as /opt/selfbuilding/browsers/. /home/agent/.cache/ms-playwright/ \
  && chown -R -h agent:agent /home/agent/.cache
RUN mkdir -p /opt/selfbuilding && printf '%s\n' '{"image":"selfbuilding-codex","version":"0.1.0","user":"agent","binaries":["/usr/local/bin/codex"],"browser":{"engine":"chromium","playwright":"1.64.1","mcp":"/usr/local/bin/playwright-mcp","browsersPath":"/opt/selfbuilding/browsers"}}' > /opt/selfbuilding/image-manifest.json
RUN /usr/local/bin/codex --version && /usr/local/bin/playwright-mcp --version && cd /selfbuilding/out && runuser -u agent -- env -i HOME=/selfbuilding/home PATH=/usr/local/bin:/usr/bin:/bin node -e "require('playwright')" && runuser -u agent -- env -i HOME=/selfbuilding/home PATH=/usr/local/bin:/usr/bin:/bin node --input-type=module -e "const { chromium } = await import('playwright'); const b = await chromium.launch({ args: ['--no-sandbox'] }); await b.close();" && runuser -u agent -- env -i HOME=/selfbuilding/home PATH=/usr/local/bin:/usr/bin:/bin node -e "require('/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright-core').chromium.launch({ args: ['--no-sandbox'] }).then((b) => b.close()).catch((e) => { console.error(e); process.exit(1); });"
WORKDIR /selfbuilding/work
LABEL org.opencontainers.image.title="selfbuilding-codex"
