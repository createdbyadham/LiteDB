#!/usr/bin/env bash
set -euo pipefail
tag=${1:?release tag}
root=$(cd "$(dirname "$0")/../.." && pwd)
version=${tag#v}
if [ "$tag" != "v${version}" ]; then
  echo "::error::Homebrew cask expects tag v<version>, got ${tag}"
  exit 1
fi

arm_url="https://github.com/createdbyadham/LiteDB/releases/download/${tag}/LiteDB_${version}_aarch64.dmg"
intel_url="https://github.com/createdbyadham/LiteDB/releases/download/${tag}/LiteDB_${version}_x64.dmg"
arm_sha=$(curl -fsSL "$arm_url" | sha256sum | awk '{print $1}')
intel_sha=$(curl -fsSL "$intel_url" | sha256sum | awk '{print $1}')

rendered=$(mktemp)
sed \
  -e "s/SHA256_ARM/${arm_sha}/g" \
  -e "s/SHA256_INTEL/${intel_sha}/g" \
  -e "s/VERSION/${version}/g" \
  "${root}/packaging/homebrew/litedb.rb" > "$rendered"

cd "$root"
export FILES="Casks/l/litedb.rb=${rendered}"
export COMMIT_MESSAGE="litedb ${version}"
export PR_BODY="Signed and notarized LiteDB ${version}.

- https://github.com/createdbyadham/LiteDB/releases/tag/${tag}"
bash packaging/publish/fork-pr.sh homebrew/homebrew-cask "litedb-${version}" "litedb ${version}"
