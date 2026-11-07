#!/usr/bin/env bash
# Writes only the Apple credentials that are actually set into GITHUB_ENV.
# An empty APPLE_ID still counts as "set" to the bundler, and it then skips
# the API-key path and tries to notarize with a blank password.
set -euo pipefail

missing=()
require() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ]; then
    missing+=("$name")
  fi
}

export_var() {
  local name="$1"
  local value="$2"
  {
    echo "${name}<<__LITE_DB_EOF__"
    printf '%s\n' "$value"
    echo "__LITE_DB_EOF__"
  } >> "$GITHUB_ENV"
}

require APPLE_CERTIFICATE "${APPLE_CERTIFICATE:-}"
require APPLE_CERTIFICATE_PASSWORD "${APPLE_CERTIFICATE_PASSWORD:-}"
require APPLE_SIGNING_IDENTITY "${APPLE_SIGNING_IDENTITY:-}"

apple_id_ready=0
api_key_ready=0
if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  apple_id_ready=1
fi
if [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] && [ -n "${APPLE_API_PRIVATE_KEY:-}" ]; then
  api_key_ready=1
fi
if [ "$apple_id_ready" -eq 0 ] && [ "$api_key_ready" -eq 0 ]; then
  missing+=("APPLE_ID+APPLE_PASSWORD+APPLE_TEAM_ID or APPLE_API_KEY+APPLE_API_ISSUER+APPLE_API_PRIVATE_KEY")
fi

if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::Missing ${missing[*]}. macOS builds are Developer ID signed and notarized; an unsigned build is the one Gatekeeper calls damaged."
  exit 1
fi

export_var APPLE_CERTIFICATE "$APPLE_CERTIFICATE"
export_var APPLE_CERTIFICATE_PASSWORD "$APPLE_CERTIFICATE_PASSWORD"
export_var APPLE_SIGNING_IDENTITY "$APPLE_SIGNING_IDENTITY"

if [ "$apple_id_ready" -eq 1 ]; then
  export_var APPLE_ID "$APPLE_ID"
  export_var APPLE_PASSWORD "$APPLE_PASSWORD"
  export_var APPLE_TEAM_ID "$APPLE_TEAM_ID"
else
  keyfile="${RUNNER_TEMP}/AuthKey_${APPLE_API_KEY}.p8"
  printf '%s\n' "$APPLE_API_PRIVATE_KEY" > "$keyfile"
  chmod 600 "$keyfile"
  export_var APPLE_API_KEY "$APPLE_API_KEY"
  export_var APPLE_API_ISSUER "$APPLE_API_ISSUER"
  export_var APPLE_API_KEY_PATH "$keyfile"
fi
