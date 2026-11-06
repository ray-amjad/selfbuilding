# syntax=docker/dockerfile:1
# Generated from @selfbuilding/images. Do not edit by hand.
FROM node:22-bookworm-slim
ARG AGENT_UID=1000
ARG AGENT_GID=1000
USER root
SHELL ["/bin/sh", "-euc"]
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl gnupg git jq ripgrep build-essential unzip python3 procps coreutils \
  && install -d -m 0755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod 0644 /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*
RUN npm --userconfig=/dev/null --ignore-scripts=false install --global --prefix /usr/local pnpm@12.16.1 bun@1.4.4
RUN userdel --remove node 2>/dev/null || true \
  && { getent group "$AGENT_GID" >/dev/null || groupadd --gid "$AGENT_GID" agent; } \
  && useradd --uid "$AGENT_UID" --gid "$AGENT_GID" --create-home --home-dir /home/agent --shell /bin/bash agent
RUN mkdir -p /selfbuilding/bin /selfbuilding/skills /selfbuilding/contract /selfbuilding/in /selfbuilding/state/launches /selfbuilding/state/calls /selfbuilding/state/logs /run/selfbuilding/secrets /opt/selfbuilding /selfbuilding/work /selfbuilding/home /selfbuilding/out /selfbuilding/state/proc \
  && chown agent:agent /selfbuilding/work /selfbuilding/home /selfbuilding/out /selfbuilding/state/proc \
  && printf '#!/bin/sh\nexec node /selfbuilding/bin/selfbuilding-mcp.mjs "$@"\n' > /usr/local/bin/selfbuilding-mcp \
  && chmod 0755 /usr/local/bin/selfbuilding-mcp
RUN mkdir -p /opt/selfbuilding && printf '%s\n' '{"image":"selfbuilding-base","version":"0.1.0","user":"agent","binaries":[]}' > /opt/selfbuilding/image-manifest.json
RUN node --version && git --version && gh --version && timeout --version >/dev/null
WORKDIR /selfbuilding/work
LABEL org.opencontainers.image.title="selfbuilding-base"
