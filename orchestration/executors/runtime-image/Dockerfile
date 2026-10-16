FROM docker.io/library/node@sha256:2c752226d477b4a886378baa95b9af252be59301b725fdb0b7e15208131505a8

RUN apk add --no-cache \
        brotli-libs=1.2.0-r1 \
        c-ares=1.34.8-r0 \
        libunistring=1.4.2-r0 \
        libidn2=2.3.8-r0 \
        nghttp2-libs=1.70.0-r0 \
        libpsl=0.21.5-r3 \
        zstd-libs=1.5.7-r2 \
        libcurl=8.22.0-r0 \
        libexpat=2.8.5-r0 \
        pcre2=10.49-r0 \
        git=2.54.0-r0 \
        git-init-template=2.54.0-r0 \
    && rm -rf /usr/local/lib/node_modules/corepack /opt/yarn-v1.22.22 \
    && rm -f /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && mkdir -p /opt/deployhub/npm-cache \
    && chown -R 1000:1000 /opt/deployhub

ENV HOME=/tmp \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    YARN_VERSION= \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_TERMINAL_PROMPT=0

USER 1000:1000
WORKDIR /workspace
ENTRYPOINT ["/bin/sleep"]
CMD ["infinity"]
