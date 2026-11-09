#!/usr/bin/env bash
# Attach the Windows installers to the draft release and point latest.json at
# the NSIS setup. When SignPath is set up they are Authenticode-signed and the
# minisign signature was made after that, so it matches the file the updater
# downloads; without it they are the build's own files and signature.
set -euo pipefail

exe=$(find installers -type f -name '*-setup.exe' -print -quit)
sig="${exe}.sig"
if [ -z "$exe" ] || [ ! -f "$sig" ]; then
  echo "::error::NSIS installer or its updater signature is missing"
  exit 1
fi

gh release download "$TAG" --repo "$REPO" --pattern latest.json --dir .
name=$(basename "$exe")
SIG_FILE="$sig" ASSET_NAME="$name" python3 - <<'PY'
import json, os, pathlib
latest = json.loads(pathlib.Path("latest.json").read_text())
signature = pathlib.Path(os.environ["SIG_FILE"]).read_text().strip()
url = (
    f"https://github.com/{os.environ['REPO']}/releases/download/"
    f"{os.environ['TAG']}/{os.environ['ASSET_NAME']}"
)
latest.setdefault("platforms", {})["windows-x86_64"] = {
    "signature": signature,
    "url": url,
}
pathlib.Path("latest.json").write_text(json.dumps(latest, indent=2) + "\n")
PY

files=("$exe" "$sig" latest.json)
while IFS= read -r msi; do
  files+=("$msi")
done < <(find installers -type f -name '*.msi' | sort)

gh release upload "$TAG" "${files[@]}" --clobber --repo "$REPO"
