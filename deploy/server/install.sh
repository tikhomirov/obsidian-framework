#!/usr/bin/env bash
# Obsidian Framework — server install on the server (idempotent).
# Usage: ./install.sh <stack-dir> [--up]
#   <stack-dir>  e.g. ~/stacks/obsidian-framework (created if missing)
# Creates: .env, docker-compose.yml, config/{tokens.json,participants.json,worker_ssh_key,deploy_key,known_hosts}, pi-home/.
# Never overwrites existing secrets. Prints only public keys and file paths, not tokens.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK="${1:?usage: install.sh <stack-dir> [--up]}"
UP="${2:-}"
mkdir -p "$STACK/config" "$STACK/pi-home"
cd "$STACK"
umask 077

need() { command -v "$1" >/dev/null || { echo "нужна команда: $1" >&2; exit 1; }; }
need ssh-keygen; need openssl; need docker

[ -f .env ] || { cp "$SRC_DIR/.env.example" .env; echo "• создан .env — заполни VAULT_DIR, TAILSCALE_IP, PUID/PGID, OF_WORKER_SSH_TARGET"; }
cp "$SRC_DIR/docker-compose.yml" docker-compose.yml
set -a; . ./.env; set +a
[ -n "${VAULT_DIR:-}" ] && [ -d "${VAULT_DIR}/.framework" ] || echo "! VAULT_DIR=${VAULT_DIR:-} — нет .framework, поправь .env"

gen() { openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-40; }
if [ ! -f config/tokens.json ]; then
  cat > config/tokens.json <<JSON
[
  { "name": "owner-plugin", "token": "$(gen)", "kind": "participant", "id": "owner", "scopes": ["api"] },
  { "name": "agent-mcp", "token": "$(gen)", "kind": "agent", "id": "agent", "scopes": ["mcp", "api"] },
  { "name": "pc-worker", "token": "$(gen)", "kind": "agent", "id": "worker-pc", "scopes": ["worker"] }
]
JSON
  echo "• создан config/tokens.json (токены — только в этом файле)"
fi
[ -f config/participants.json ] || cp "$SRC_DIR/config/participants.example.json" config/participants.json
[ -f config/worker_ssh_key ] || ssh-keygen -q -t ed25519 -N "" -C "of-coordinator" -f config/worker_ssh_key
[ -f config/deploy_key ] || ssh-keygen -q -t ed25519 -N "" -C "of-deploy" -f config/deploy_key
touch config/known_hosts

if [ -n "${OF_WORKER_SSH_TARGET:-}" ]; then
  host="${OF_WORKER_SSH_TARGET#*@}"
  if ! ssh-keygen -F "$host" -f config/known_hosts >/dev/null; then
    ssh-keyscan -T 5 -t ed25519 "$host" >> config/known_hosts 2>/dev/null && echo "• known_hosts: добавлен $host — сверь отпечаток:" && ssh-keygen -lf config/known_hosts | grep -F "$host" || echo "! ssh-keyscan $host не ответил (ПК выключен или sshd не слушает Tailscale) — повтори install.sh позже"
  fi
fi
GIT_HOST="${GIT_HOST:-git.example.com}"; GIT_SSH_PORT="${GIT_SSH_PORT:-22}"
GIT_SCAN_ADDR="${GIT_SCAN_ADDR:-$GIT_HOST}"
if [ "$GIT_SSH_PORT" = "22" ]; then GIT_KH="$GIT_HOST"; else GIT_KH="[$GIT_HOST]:$GIT_SSH_PORT"; fi
if ! ssh-keygen -F "$GIT_KH" -f config/known_hosts >/dev/null; then
  line="$(ssh-keyscan -T 5 -p "$GIT_SSH_PORT" -t ed25519 "$GIT_SCAN_ADDR" 2>/dev/null | grep -v '^#' | head -1)"
  if [ -n "$line" ]; then echo "$GIT_KH ${line#* }" >> config/known_hosts; echo "• known_hosts: добавлен $GIT_KH"; else echo "! не удалось получить ключ $GIT_SCAN_ADDR:$GIT_SSH_PORT"; fi
fi

chown -R "${PUID:-1000}:${PGID:-1000}" config pi-home 2>/dev/null || echo "! chown не удался — запусти: sudo chown -R ${PUID:-1000}:${PGID:-1000} $STACK/config $STACK/pi-home"
chmod 700 config; chmod 600 config/*; chmod 644 config/*.pub config/known_hosts config/participants.json 2>/dev/null || true

echo
echo "=== строка для ~/.ssh/authorized_keys на ПК (одна строка) ==="
echo "command=\"\$HOME/.local/bin/of-worker\",restrict $(cat config/worker_ssh_key.pub)"
echo
echo "=== deploy key (read-only) для git-хостинга (${GIT_HOST}) → Deploy keys, только чтение ==="
cat config/deploy_key.pub
echo
if [ "$UP" = "--up" ]; then
  docker compose up -d --build
  sleep 3
  curl -fsS "http://${TAILSCALE_IP}:8787/health" && echo
else
  echo "Дальше: cd $STACK && docker compose up -d --build"
fi
