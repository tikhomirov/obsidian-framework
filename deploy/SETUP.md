# Установка Obsidian Framework — шаги установки

Всё, что ниже, делаешь ты сам: скрипты сервер/sshd не трогают и ничего не ставят глобально на ПК.

## 1. ПК: sshd только на Tailscale
1. `sudo bash <vault>/.framework/deploy/pc/setup-sshd.sh` (на CIFS нет +x) — ставит openssh-server без автозапуска, `ListenAddress <Tailscale-IP>`, пароли выключены, без ssh.socket, ждёт tailscaled; бэкап в `/var/backups/of-sshd-*`.
2. Проверка: `ss -ltn | grep :22` — только 100.x.

## 2. Сервер
1. `bash <vault>/.framework/deploy/server/install.sh ~/stacks/obsidian-framework`
2. Заполни `~/stacks/obsidian-framework/.env`: `VAULT_DIR`, `TAILSCALE_IP` (`tailscale ip -4`), `PUID/PGID` (владелец vault), `OF_WORKER_SSH_TARGET=user@<tailscale-имя ПК>`, `GIT_HOST`.
3. Запусти `install.sh` ещё раз (подтянет known_hosts ПК и git-хоста — сверь отпечатки).
4. Deploy key: `config/deploy_key.pub` → git-хостинг → Deploy keys, **только чтение**.
5. Pi на сервере: скопируй с ПК `~/.pi/agent/{auth.json,models.json,settings.json}` в `~/stacks/obsidian-framework/pi-home/agent/` (или логин: `docker compose run --rm -it of-server pi` → `/login`).
6. Скиллы AIF для Pi: `aif-plan`, `aif-improve`, `aif-review`, `aif-verify` → `pi-home/agent/skills/`.
7. `docker compose up -d --build`, проверка: `curl http://<TAILSCALE_IP>:8787/health`.

## 3. ПК: of-worker
1. `bash <vault>/.framework/deploy/pc/install-of-worker.sh`
2. `~/.config/obsidian-framework/worker.json`: `serverUrl` = `http://<tailscale-имя сервера>:8787`, `token` = `pc-worker` из `config/tokens.json` сервера, `projects` = `{ "of": "<путь к локальному клону репо>" }`.
3. В `~/.ssh/authorized_keys` — одна строка, которую напечатал `install.sh` сервера (`command="…/of-worker",restrict ssh-ed25519 …`).
4. Скилл `aif-implement` (и `aif-plan` для plan-checker) для OpenCode → `~/.config/opencode/skills/`.
5. MCP для ручного режима (OpenCode, `~/.config/opencode/opencode.jsonc`, раздел `mcp`):
   `"obsidian-framework": { "type": "remote", "url": "http://<сервер>:8787/mcp", "headers": { "Authorization": "Bearer {env:OF_MCP_TOKEN}" } }`,
   `OF_MCP_TOKEN` = `agent-mcp` из `config/tokens.json`. Для Pi — то же в `~/.pi/agent/mcp.json`.
6. Проверка с сервера: `docker exec of-server ssh -i /config/worker_ssh_key -o UserKnownHostsFile=/config/known_hosts user@<ПК> status` → `{"ok":true,…}`.

## 4. Vault
1. `Проекты/Obsidian Framework/Проект.md` — по образцу `deploy/project.example.md` (поле `repo` — git-адрес).
2. `Проекты/Obsidian Framework/models.json` — по образцу `deploy/models.example.json`, свои модели по ролям.

## 5. Плагин
1. `bash <vault>/.framework/deploy/pc/install-plugin.sh`
2. Obsidian → Сторонние плагины → включить «Obsidian Framework» → адрес сервера (Tailscale) и токен `owner-plugin`.
3. Доска проекта — файл `Проекты/<Проект>/Доска.md` (Р-034): открой его в Obsidian или нажми иконку «Доска задач» в левой ленте / `Ctrl+P` → «Открыть доску задач». Нет файла — плагин и сервер создадут.
4. На доске: создать задачу → перетащить в «Планирование» → смотреть историю.
