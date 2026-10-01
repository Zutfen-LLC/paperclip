# Toolchain image for the self-hosted CI lanes (.github/workflows/ci.yml).
#
# The runner host is orchestration only: it needs Git and Docker, never Node,
# pnpm or Rust. Everything repository-controlled runs inside this image via
# .github/scripts/ci-run.sh. The image carries tools, not source — the checkout
# is bind-mounted — so the Dockerfile is built from stdin with no context.
#
# pnpm and the Rust channel are build args read from package.json and
# packages/paperclip-runner/rust-toolchain.toml by ci-run.sh, so those files
# stay the single pin and a bump rebuilds the image under a new tag.
FROM node:24-trixie

ARG PNPM_VERSION
ARG RUST_TOOLCHAIN
ARG RUSTUP_VERSION=1.29.0
ARG RUSTUP_SHA256_AMD64=4acc9acc76d5079515b46346a485974457b5a79893cfb01112423c89aeb5aa10

RUN test -n "$PNPM_VERSION" && test -n "$RUST_TOOLCHAIN"

# The full node image already ships git, gcc, make, python3, curl and ps, but
# not lsof. GitHub-hosted runners do, and the local service supervisor reads
# port listener pids with it (server/src/services/local-service-supervisor.ts):
# without it the runtime-service tests cannot tell their own listener from a
# foreign one and fail with "could not bind allocated port".
RUN apt-get update \
  && apt-get install -y --no-install-recommends jq lsof ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN npm install --global "pnpm@${PNPM_VERSION}"

# Same version-pinned, checksum-verified rustup install as the production
# Dockerfile. x64 only: this image is for [self-hosted, linux, x64] runners.
# Installed under /usr/local so a non-root runner uid can use it; ci-run.sh
# points CARGO_HOME at a writable cache for registry downloads at run time.
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH
RUN set -eux; \
    test "$(dpkg --print-architecture)" = amd64; \
    curl -fsSLo /tmp/rustup-init "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/x86_64-unknown-linux-gnu/rustup-init"; \
    echo "${RUSTUP_SHA256_AMD64}  /tmp/rustup-init" | sha256sum -c -; \
    chmod +x /tmp/rustup-init; \
    /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain none; \
    rm /tmp/rustup-init; \
    rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal --component rustfmt; \
    rustup default "$RUST_TOOLCHAIN"; \
    chmod -R a+rX "$RUSTUP_HOME" "$CARGO_HOME"

ENV CI=true \
    CARGO_INCREMENTAL=0 \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false
