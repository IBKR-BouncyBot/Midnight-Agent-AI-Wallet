#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
target="$project_root/.tools/compact/versions/0.31.1/x86_64-unknown-linux-musl"
mkdir -p "$target"
cd "$target"
curl --fail --location --retry 3 'https://github.com/midnightntwrk/compact/releases/download/compactc-v0.31.1/compactc_v0.31.1_x86_64-unknown-linux-musl.zip' -o artifact.zip
printf '%s  %s\n' 'e291b4bab4d4e857707008f8b1c25c2b8e0c843f6c737d0ee6c0d9ac69a6bbfb' artifact.zip | sha256sum --check
unzip -o artifact.zip
chmod +x compactc compactc.bin zkir zkir-v3
./compactc --version

