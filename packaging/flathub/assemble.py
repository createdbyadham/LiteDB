#!/usr/bin/env python3
"""Merge vendored npm and cargo sources into a Flathub manifest.

flatpak-node-generator and flatpak-cargo-generator each write a JSON list of
sources. Flathub builds offline, so those lists have to be in the manifest
that the release workflow opens a pull request with. They are not committed
here; a lockfile change makes them stale immediately.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_sources(path: Path) -> list:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("sources"), list):
        return data["sources"]
    raise SystemExit(f"{path} is not a Flatpak source list")


def manifest(version: str, commit: str, cargo: list, npm: list) -> dict:
    install_bin = r"""
if [ -f src-tauri/target/release/LiteDB ]; then
  install -Dm755 src-tauri/target/release/LiteDB /app/bin/litedb
elif [ -f src-tauri/target/release/litedb ]; then
  install -Dm755 src-tauri/target/release/litedb /app/bin/litedb
else
  echo "release binary not found" >&2
  ls -la src-tauri/target/release
  exit 1
fi
install -Dm644 packaging/flathub/com.adhamehab.litedb.desktop /app/share/applications/com.adhamehab.litedb.desktop
install -Dm644 packaging/flathub/com.adhamehab.litedb.metainfo.xml /app/share/metainfo/com.adhamehab.litedb.metainfo.xml
install -Dm644 src-tauri/icons/128x128.png /app/share/icons/hicolor/128x128/apps/com.adhamehab.litedb.png
install -Dm644 src-tauri/icons/128x128@2x.png /app/share/icons/hicolor/256x256/apps/com.adhamehab.litedb.png
""".strip()
    return {
        "app-id": "com.adhamehab.litedb",
        "runtime": "org.gnome.Platform",
        "runtime-version": "49",
        "sdk": "org.gnome.Sdk",
        "sdk-extensions": [
            "org.freedesktop.Sdk.Extension.rust-stable",
            "org.freedesktop.Sdk.Extension.node22",
        ],
        "command": "litedb",
        "finish-args": [
            "--share=ipc",
            "--share=network",
            "--socket=fallback-x11",
            "--socket=wayland",
            "--device=dri",
            "--filesystem=host",
            "--talk-name=org.freedesktop.secrets",
        ],
        "modules": [
            {
                "name": "litedb",
                "buildsystem": "simple",
                "build-options": {
                    "append-path": "/usr/lib/sdk/rust-stable/bin:/usr/lib/sdk/node22/bin",
                    "env": {
                        "CARGO_HOME": "/run/build/litedb/cargo",
                        "CARGO_NET_OFFLINE": "true",
                    },
                },
                "build-commands": [
                    "cargo fetch --offline --manifest-path src-tauri/Cargo.toml --verbose",
                    "npm ci --offline",
                    "npm run tauri build -- --no-bundle",
                    install_bin,
                ],
                "sources": [
                    {
                        "type": "git",
                        "url": "https://github.com/createdbyadham/LiteDB.git",
                        "tag": f"v{version}",
                        "commit": commit,
                    },
                    *cargo,
                    *npm,
                ],
            }
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--cargo", required=True, type=Path)
    parser.add_argument("--npm", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if len(args.commit) != 40 or any(c not in "0123456789abcdef" for c in args.commit):
        raise SystemExit(f"commit must be a 40-character sha, got {args.commit}")

    out = args.output
    out.mkdir(parents=True, exist_ok=True)
    manifest_path = out / "com.adhamehab.litedb.json"
    manifest_path.write_text(
        json.dumps(
            manifest(args.version, args.commit, load_sources(args.cargo), load_sources(args.npm)),
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (out / "flathub.json").write_text(
        json.dumps({"only-arches": ["x86_64"]}, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
