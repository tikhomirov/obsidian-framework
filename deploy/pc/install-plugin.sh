#!/usr/bin/env bash
# Obsidian Framework — build the Obsidian plugin and copy it into the vault.
# Usage: ./install-plugin.sh [vault-dir]   (default: the vault that contains this .framework)
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_build.sh"
vault="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
[ -d "$vault/.obsidian" ] || { echo "$vault не похож на vault (нет .obsidian)" >&2; exit 1; }
of_build
dest="$vault/.obsidian/plugins/obsidian-framework"
mkdir -p "$dest"
for f in main.js manifest.json styles.css; do cp "$OF_BUILD/packages/plugin/$f" "$dest/$f"; done
echo "• плагин скопирован в $dest"
echo "  Obsidian → Настройки → Сторонние плагины → включить «Obsidian Framework»,"
echo "  в его настройках: адрес сервера (Tailscale) и токен owner-plugin."
