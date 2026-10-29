#!/usr/bin/env bash
# Obsidian Framework — sshd на ПК только на адресе Tailscale (Ubuntu, systemd). Запуск: sudo ./setup-sshd.sh
# Идемпотентно. Бэкап /etc/ssh → /var/backups/of-sshd-<время>. Ключи в authorized_keys НЕ добавляет.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "запусти через sudo" >&2; exit 1; }
TS_IP="${1:-$(tailscale ip -4 | head -1)}"
[[ "$TS_IP" =~ ^100\. ]] || { echo "нет Tailscale IPv4 (получено: $TS_IP)" >&2; exit 1; }
SSH_USER="${SUDO_USER:-owner}"
BAK="/var/backups/of-sshd-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$BAK"
[ -d /etc/ssh ] && cp -a /etc/ssh "$BAK/"
[ -d /etc/systemd/system/ssh.service.d ] && cp -a /etc/systemd/system/ssh.service.d "$BAK/"
echo "• бэкап: $BAK"

# 1. Конфиг до установки пакета: первый файл в sshd_config.d выигрывает.
mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/10-obsidian-framework.conf <<CONF
# Obsidian Framework: только Tailscale, только ключи.
ListenAddress $TS_IP
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers $SSH_USER
CONF

# 2. Пакет — без автозапуска на 0.0.0.0 во время установки.
if ! dpkg -s openssh-server >/dev/null 2>&1; then
  printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d; chmod 755 /usr/sbin/policy-rc.d
  trap 'rm -f /usr/sbin/policy-rc.d' EXIT
  DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server
  rm -f /usr/sbin/policy-rc.d; trap - EXIT
fi

# 3. Без socket-активации (она слушает 0.0.0.0); ssh.service ждёт tailscaled и перезапускается.
systemctl disable --now ssh.socket 2>/dev/null || true
mkdir -p /etc/systemd/system/ssh.service.d
cat > /etc/systemd/system/ssh.service.d/10-obsidian-framework.conf <<UNIT
[Unit]
After=network-online.target tailscaled.service
Wants=network-online.target tailscaled.service
[Service]
Restart=on-failure
RestartSec=5
UNIT
sshd -t
systemctl daemon-reload
systemctl enable ssh.service
systemctl restart ssh.service
sleep 1

# 4. Проверка: слушает только Tailscale.
echo "• слушает:"; ss -ltnH '( sport = :22 )' | awk '{print "  " $4}'
ss -ltnH '( sport = :22 )' | grep -q "$TS_IP:22" || { echo "! sshd не слушает $TS_IP:22: journalctl -u ssh -n 30" >&2; exit 1; }
if ss -ltnH '( sport = :22 )' | awk '{print $4}' | grep -qv "^$TS_IP:22$"; then
  echo "! sshd слушает не только $TS_IP — проверь /etc/ssh/sshd_config*" >&2; exit 1
fi
echo "• ок: sshd только на $TS_IP:22, пароли выключены"
