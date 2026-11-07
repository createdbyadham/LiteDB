#!/usr/bin/env bash
# The release tag, the app version, and the links in the README and changelog
# have to be the same string. app-v2.4.0 with a badge pointing at v2.4.0 is
# how the download button ended up on a tag with no installers.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
version=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$root/src-tauri/tauri.conf.json")
tag="v${version}"
if [ "${GITHUB_REF_NAME}" != "$tag" ]; then
  echo "::error::Pushed ${GITHUB_REF_NAME}, but the app version is ${version}. Publish on ${tag}."
  exit 1
fi
for file in README.md CHANGELOG.md; do
  if ! grep -q "releases/tag/${tag}" "${root}/${file}"; then
    echo "::error::${file} does not link to releases/tag/${tag}"
    exit 1
  fi
done
