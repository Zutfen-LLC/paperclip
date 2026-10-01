#!/usr/bin/env bash
# Run a command in the CI toolchain image (.github/ci.Dockerfile) as the
# invoking user, with the checkout bind-mounted in place.
#
#   .github/scripts/ci-run.sh [--no-install] [--target-cache NAME]
#                             [-e NAME[=VALUE]]... -- <command>
#
# Dependencies are installed first (frozen lockfile) unless --no-install is
# given. The host needs only Git and Docker; the same invocation works from a
# developer machine to reproduce a CI lane locally.
#
# Persistent host caches live under PAPERCLIP_CI_CACHE (default
# ~/.cache/paperclip-ci): the pnpm store, the Cargo registry, and the Runner's
# Rust target directory. The target directory is mounted over the in-tree path
# that scripts/stage-runner-binary.mjs hardcodes, so the checkout's clean step
# cannot discard a warm build.
#
# --target-cache NAME (default "default") picks which target directory is
# mounted. Lanes that build different Rust profiles must not share one: some
# server tests run only when a debug paperclip-runnerd exists but then resolve
# the release binary, so a debug build left behind by another lane turns a
# test that ephemeral upstream runners skip into a failure.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

install=1
target_cache=default
env_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-install) install=0; shift ;;
    --target-cache) target_cache="$2"; shift 2 ;;
    -e) env_args+=(--env "$2"); shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
if [ $# -eq 0 ]; then
  echo "usage: ci-run.sh [--no-install] [--target-cache NAME] [-e NAME[=VALUE]]... -- <command>" >&2
  exit 2
fi
case "$target_cache" in
  ''|*[!A-Za-z0-9_-]*)
    echo "--target-cache must be a non-empty name of letters, digits, '-' or '_'" >&2
    exit 2 ;;
esac

pnpm_version="$(sed -nE 's/.*"packageManager": *"pnpm@([0-9.]+)[^"]*".*/\1/p' package.json)"
rust_toolchain="$(sed -nE 's/^channel *= *"([^"]+)".*/\1/p' packages/paperclip-runner/rust-toolchain.toml)"
if [ -z "$pnpm_version" ] || [ -z "$rust_toolchain" ]; then
  echo "could not read the pnpm version from package.json or the Rust channel from rust-toolchain.toml" >&2
  exit 1
fi

# Content-addressed tag: unchanged inputs reuse the image already in the
# persistent daemon, and a pin bump builds under a fresh tag.
tag="$(printf '%s\n%s\n' "$pnpm_version" "$rust_toolchain" | cat - .github/ci.Dockerfile | sha256sum | cut -c1-12)"
image="paperclip-ci:$tag"

if ! docker image inspect "$image" >/dev/null 2>&1; then
  DOCKER_BUILDKIT=1 docker build \
    --tag "$image" \
    --build-arg "PNPM_VERSION=$pnpm_version" \
    --build-arg "RUST_TOOLCHAIN=$rust_toolchain" \
    - < .github/ci.Dockerfile
  # Drop superseded toolchain images. Best effort: one still in use by a
  # concurrent job refuses removal, which is fine.
  docker image ls paperclip-ci --format '{{.Repository}}:{{.Tag}}' \
    | grep -vxF "$image" | xargs -r docker image rm >/dev/null 2>&1 || true
fi

cache="${PAPERCLIP_CI_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/paperclip-ci}"
runner_target="$cache/runner-target-$target_cache"
mkdir -p "$cache/pnpm-store" "$cache/cargo" "$runner_target"

# Single-quoted on purpose: the container shell expands $HOME, not this one.
# shellcheck disable=SC2016
script='mkdir -p "$HOME"'
if [ "$install" -eq 1 ]; then
  script+=$'\n.github/scripts/ci-install.sh'
fi
script+=$'\n'"$*"

exec docker run --rm --init \
  --user "$(id -u):$(id -g)" \
  --shm-size 1g \
  --env HOME=/tmp/ci-home \
  --env "CARGO_HOME=$cache/cargo" \
  --env "npm_config_store_dir=$cache/pnpm-store" \
  ${env_args[@]+"${env_args[@]}"} \
  --volume "$root:$root" \
  --volume "$cache/pnpm-store:$cache/pnpm-store" \
  --volume "$cache/cargo:$cache/cargo" \
  --volume "$runner_target:$root/packages/paperclip-runner/runner/target" \
  --workdir "$root" \
  "$image" \
  bash -euo pipefail -c "$script"
