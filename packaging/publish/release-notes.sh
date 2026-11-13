#!/usr/bin/env bash
# Release notes for one version: its CHANGELOG.md section plus install notes.
#   release-notes.sh 2.6.2            prints the notes
# In the release workflow (GITHUB_OUTPUT set, version from the v* tag), it
# writes them to the step output `body` instead.
set -euo pipefail

version="${1:-${GITHUB_REF_NAME#v}}"
root="$(cd "$(dirname "$0")/../.." && pwd)"

# Lines after "## [<version>]" up to the next "## [" heading, trimmed.
section="$(awk -v v="$version" '
  index($0, "## [" v "]") == 1 { on = 1; next }
  on && /^## \[/ { exit }
  on { print }
' "$root/CHANGELOG.md" | tr -d '\r' | sed -e '/./,$!d' | sed -e ':a' -e '/^\n*$/{$d;N;ba' -e '}')"

if [ -z "$section" ]; then
  echo "::error::CHANGELOG.md has no section for $version." >&2
  exit 1
fi

body="$section

### Install

Download the installer for your platform below. The macOS app is signed and notarized by Apple. The Windows installers are not code-signed yet, so SmartScreen may warn: choose **More info**, then **Run anyway**.

Full history: [CHANGELOG.md](https://github.com/createdbyadham/LiteDB/blob/main/CHANGELOG.md)"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "body<<LITEDB_NOTES_EOF"
    echo "$body"
    echo "LITEDB_NOTES_EOF"
  } >> "$GITHUB_OUTPUT"
else
  echo "$body"
fi
