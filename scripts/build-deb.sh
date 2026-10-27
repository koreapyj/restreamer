#!/usr/bin/env bash
# restreamer - HLS restreaming daemon and switcher for tvheadend
# Copyright (C) 2026 Yoonji Park
#
# This program is free software: you can redistribute it and/or modify it
# under the terms of the GNU Affero General Public License as published by
# the Free Software Foundation, either version 3 of the License, or any
# later version. This program is distributed WITHOUT ANY WARRANTY; see
# <https://www.gnu.org/licenses/> for details.
#
# Build the Debian package for the restreamer DAEMON. The repo's second
# deployable, the switcher, is NOT part of this deb — it ships as a container
# image (deploy/switcher.Dockerfile + deploy/k8s/).
#
# The deb is self-contained: it bundles the official Node.js linux runtime
# (bin/node only) for the target architecture under
# /usr/lib/restreamer/runtime, so the target host needs no Node.js. Hence the
# deb is architecture-specific (amd64 or arm64).
#
# Usage: scripts/build-deb.sh [--stage-only]
#   env VERSION       deb version (default: package.json version)
#   env NODE_VERSION  bundled Node.js version (default: pinned below)
#   env DEB_ARCH      amd64 | arm64 (default: the build host's architecture)
#
# The caller must have run `pnpm install --frozen-lockfile` beforehand.
# --stage-only assembles the staging tree and stops before the Linux-only
# steps (Node runtime download, dpkg-deb) — a cross-platform dry run used
# for testing on non-Linux dev machines.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Pinned Node.js runtime. When bumping NODE_VERSION, update both
# NODE_SHA256_PIN_* from https://nodejs.org/dist/v<version>/SHASUMS256.txt
# (linux-x64.tar.xz and linux-arm64.tar.xz).
NODE_VERSION="${NODE_VERSION:-26.4.0}"
NODE_SHA256_PIN_x64="5c4286dcd5bbd5acb1ccc7eb0e088bd5eb1e3affad671ee9364004f8f6a4a431"
NODE_SHA256_PIN_arm64="f6d8eedc52170667d45730ac2f413c4aa1e7cd2165c9cac5746ef3cb0f4ec45a"
NODE_SHA256_PIN_FOR="26.4.0"

# Debian architecture -> Node.js dist architecture. The bundled runtime runs
# natively on the target, so build each arch on a matching runner.
if [ -z "${DEB_ARCH:-}" ]; then
  case "$(uname -m)" in
    x86_64 | amd64) DEB_ARCH=amd64 ;;
    aarch64 | arm64) DEB_ARCH=arm64 ;;
    *) echo "unsupported build host architecture: $(uname -m); set DEB_ARCH" >&2; exit 2 ;;
  esac
fi
case "$DEB_ARCH" in
  amd64) NODE_ARCH=x64 ;;
  arm64) NODE_ARCH=arm64 ;;
  *) echo "unsupported DEB_ARCH: $DEB_ARCH (amd64 | arm64)" >&2; exit 2 ;;
esac
NODE_SHA256_PIN_VAR="NODE_SHA256_PIN_$NODE_ARCH"
NODE_SHA256_PIN="${!NODE_SHA256_PIN_VAR}"

STAGE_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --stage-only) STAGE_ONLY=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

cd "$REPO_ROOT"
VERSION="${VERSION:-$(node -p "require('./package.json').version")}"

OUT="$REPO_ROOT/out"
STAGING="$OUT/staging"
APPDIR="$STAGING/usr/lib/restreamer"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

rm -rf "$STAGING"
mkdir -p "$OUT" "$APPDIR" "$STAGING/lib/systemd/system" \
  "$STAGING/etc/restreamer" "$STAGING/usr/share/doc/restreamer" \
  "$STAGING/DEBIAN"

echo "==> pnpm build (tsc -b)"
pnpm build

echo "==> staging application tree (version $VERSION)"
cp -R dist "$APPDIR/dist"
# The switcher is the container-image deployable; nothing under dist/ outside
# dist/switcher/ imports from it, so pruning keeps the daemon deb lean.
rm -rf "$APPDIR/dist/switcher"
# dist/version.js resolves ../package.json at runtime — package.json must
# stay adjacent to dist/ inside the deb.
cp package.json "$APPDIR/package.json"

echo "==> production node_modules (pnpm, hoisted: no symlinked store in the deb)"
# This repo is a single package, not a pnpm workspace, so `pnpm deploy --prod`
# is unavailable; a plain prod install into a scratch dir does the same job.
# node-linker=hoisted yields a flat npm-style tree (deps are pure JS).
DEPS="$WORK/deps"
mkdir -p "$DEPS"
cp package.json pnpm-lock.yaml "$DEPS/"
printf 'node-linker=hoisted\n' >"$DEPS/.npmrc"
(cd "$DEPS" && pnpm install --prod --frozen-lockfile --ignore-scripts)
rm -rf "$DEPS/node_modules/.bin" "$DEPS/node_modules/.modules.yaml" \
  "$DEPS/node_modules/.pnpm-workspace-state.json"
cp -R "$DEPS/node_modules" "$APPDIR/node_modules"

echo "==> config, unit, docs, maintainer scripts"
cp deploy/deb/restreamer.service "$STAGING/lib/systemd/system/restreamer.service"
# conffile: seeded from config.example.yaml; dpkg preserves admin edits.
cp config.example.yaml "$STAGING/etc/restreamer/config.yaml"
cp README.md "$STAGING/usr/share/doc/restreamer/README.md"
cp LICENSE.md "$STAGING/usr/share/doc/restreamer/copyright"
cp deploy/deb/conffiles "$STAGING/DEBIAN/conffiles"
for script in postinst prerm postrm; do
  cp "deploy/deb/$script" "$STAGING/DEBIAN/$script"
  chmod 0755 "$STAGING/DEBIAN/$script"
done

write_control() {
  local installed_size
  installed_size="$(du -sk --exclude=DEBIAN "$STAGING" | cut -f1)"
  sed -e "s/@VERSION@/$VERSION/" \
      -e "s/@ARCH@/$DEB_ARCH/"       -e "s/@INSTALLED_SIZE@/$installed_size/" \
      deploy/deb/control.in >"$STAGING/DEBIAN/control"
}

if [ "$STAGE_ONLY" = 1 ]; then
  write_control
  echo "==> --stage-only: skipping Node runtime download and dpkg-deb"
  echo "==> staging tree at $STAGING:"
  (cd "$STAGING" && find . \( -type f -o -type l \) | sort)
  exit 0
fi

echo "==> bundling Node.js v$NODE_VERSION runtime (linux-$NODE_ARCH, bin/node only)"
NODE_DIST="node-v${NODE_VERSION}-linux-${NODE_ARCH}"
curl -fsSL -o "$WORK/$NODE_DIST.tar.xz" \
  "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIST}.tar.xz"
curl -fsSL -o "$WORK/SHASUMS256.txt" \
  "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
(cd "$WORK" && grep " ${NODE_DIST}.tar.xz\$" SHASUMS256.txt | sha256sum -c -)
if [ "$NODE_VERSION" = "$NODE_SHA256_PIN_FOR" ]; then
  # defense in depth for the default version: pin recorded in this repo
  (cd "$WORK" && echo "$NODE_SHA256_PIN  $NODE_DIST.tar.xz" | sha256sum -c -)
fi
tar -xJf "$WORK/$NODE_DIST.tar.xz" -C "$WORK" "$NODE_DIST/bin/node"
mkdir -p "$APPDIR/runtime/bin"
install -m 0755 "$WORK/$NODE_DIST/bin/node" "$APPDIR/runtime/bin/node"

write_control

echo "==> dpkg-deb"
# normalize permissions (pnpm store perms vary); dpkg-deb owns ownership
chmod -R u+rwX,go+rX,go-w "$STAGING"
for script in postinst prerm postrm; do
  chmod 0755 "$STAGING/DEBIAN/$script"
done
DEB="$OUT/restreamer_${VERSION}_${DEB_ARCH}.deb"
dpkg-deb --build --root-owner-group "$STAGING" "$DEB"

echo "==> package info"
dpkg-deb --info "$DEB"
dpkg-deb --contents "$DEB"

if command -v lintian >/dev/null 2>&1; then
  echo "==> lintian (informational, non-fatal)"
  lintian --no-tag-display-limit "$DEB" || true
fi

echo "==> built $DEB"
