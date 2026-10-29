#!/usr/bin/env bash
# Obsidian Framework — of-worker on the PC (idempotent, user-level only).
# Installs: ~/.local/share/obsidian-framework/of-worker.mjs, ~/.local/bin/of-worker,
#           ~/.config/obsidian-framework/worker.json (template, chmod 600, never overwritten).
# Does NOT touch sshd, ~/.ssh or system settings: prints the authorized_keys line hint instead.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/_build.sh"
of_build

share="$HOME/.local/share/obsidian-framework"; bin="$HOME/.local/bin"; cfgdir="$HOME/.config/obsidian-framework"
mkdir -p "$share" "$bin" "$cfgdir" "$HOME/.cache/obsidian-framework/worktrees"
install -m 755 "$OF_BUILD/packages/worker/dist-bundle/of-worker.mjs" "$share/of-worker.mjs"

node_bin="$(command -v node)"
oc="$(command -v opencode || true)"; pi="$(command -v pi || true)"
extra_path="$(dirname "$node_bin")"
for b in "$oc" "$pi"; do [ -n "$b" ] && extra_path="$extra_path:$(dirname "$b")"; done
cat > "$bin/of-worker" <<WRAP
#!/usr/bin/env bash
# ssh forced command entry (authorized_keys: command="$bin/of-worker",restrict)
export PATH="$extra_path:\$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
exec "$node_bin" "$share/of-worker.mjs" "\$@"
WRAP
chmod 755 "$bin/of-worker"

if [ ! -f "$cfgdir/worker.json" ]; then
  umask 077
  sed -e "s#\"opencodeBin\": \"opencode\"#\"opencodeBin\": \"${oc:-opencode}\"#" \
      -e "s#\"piBin\": \"pi\"#\"piBin\": \"${pi:-pi}\"#" \
      -e "s#/home/user#$HOME#g" \
      "$(dirname "${BASH_SOURCE[0]}")/worker.example.json" > "$cfgdir/worker.json"
  echo "• создан $cfgdir/worker.json — впиши token (pc-worker из tokens.json сервера) и пути проектов"
fi
chmod 600 "$cfgdir/worker.json"
[ -n "$oc" ] || echo "! opencode не найден в PATH — поправь opencodeBin в worker.json"
[ -n "$pi" ] || echo "! pi не найден в PATH — поправь piBin в worker.json (нужен только для runtime pi)"

echo "• проверка: $("$bin/of-worker" status)"
echo
echo "Строку для ~/.ssh/authorized_keys печатает install.sh на сервере, формат:"
echo "  command=\"$bin/of-worker\",restrict ssh-ed25519 AAAA… of-coordinator"
