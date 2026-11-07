#!/usr/bin/env bash
# Attach the Authenticode-signed installers to the draft release and point
# latest.json at the signed NSIS setup. The minisign signature was produced
# after signing, so it matches the file the updater will download.
set -euo pipefail

exe=$(find signed -type f -name '*-setup.exe' -print -quit)
sig="${exe}.sig"
if [ -z "$exe" ] || [ ! -f "$sig" ]; then
  echo "::error::Signed NSIS installer or its updater signature is missing"
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
done < <(find signed -type f -name '*.msi' | sort)

gh release upload "$TAG" "${files[@]}" --clobber --repo "$REPO"
