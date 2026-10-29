# shellcheck shell=bash
# Shared helper: build the framework in a local (non-CIFS) dir. node_modules stay there, nothing global.
of_build() {
  local src build
  src="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  build="${OF_BUILD_DIR:-$HOME/.cache/obsidian-framework/build}"
  command -v node >/dev/null || { echo "нужен node (>=20) в PATH" >&2; return 1; }
  command -v rsync >/dev/null || { echo "нужен rsync" >&2; return 1; }
  mkdir -p "$build"
  rsync -a --delete --exclude node_modules --exclude dist --exclude dist-bundle --exclude coverage \
    --exclude '*.tsbuildinfo' --exclude packages/plugin/main.js "$src/" "$build/"
  (cd "$build" && npm ci --no-audit --no-fund --loglevel=error && npm run -s build) >&2
  OF_BUILD="$build"
}
