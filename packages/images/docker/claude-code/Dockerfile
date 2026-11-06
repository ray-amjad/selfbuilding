# syntax=docker/dockerfile:1
# Generated from @selfbuilding/images. Do not edit by hand.
ARG BASE_IMAGE=selfbuilding/base:0.1.0
FROM $BASE_IMAGE
USER root
SHELL ["/bin/sh", "-euc"]
ENV DISABLE_AUTOUPDATER=1
RUN npm --userconfig=/dev/null --ignore-scripts=false install --global --prefix /usr/local @anthropic-ai/claude-code@2.1.316
RUN mkdir -p /opt/selfbuilding && printf '%s\n' '{"image":"selfbuilding-claude-code","version":"0.1.0","user":"agent","binaries":["/usr/local/bin/claude"]}' > /opt/selfbuilding/image-manifest.json
RUN /usr/local/bin/claude --version
WORKDIR /selfbuilding/work
LABEL org.opencontainers.image.title="selfbuilding-claude-code"
