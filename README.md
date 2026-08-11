# Summate 8

Summate — один постоянно живущий агент для одного владельца. Он работает на Linux
VPS, принимает команды из Telegram forum topics и исполняет их через официальный
Codex App Server с авторизацией ChatGPT subscription.

## Модель

```text
Project
  ├── Workspace: local Git repository
  └── Conversation: Telegram topic
        ├── Codex thread
        └── Active run: 0..1
```

- разные Telegram topics выполняются параллельно;
- в одном topic одновременно работает только один run;
- reply на потоковый ответ или `/steer` направляется в активный Codex turn;
- остальные сообщения объединяются в следующий turn;
- каждая conversation получает постоянный Git worktree и ветку;
- project memory общая для всех topics проекта;
- Web UI, CLI, Mini App, Claudexor, swarm, MCP, marketplaces, local models,
  schedules и автономная Evolution отсутствуют.

## Требования

- Linux;
- Node.js 24+ и npm;
- Git;
- установленный `codex` с командой `codex app-server`;
- Telegram bot token;
- Telegram user ID владельца;
- ChatGPT plan с доступом к Codex.

Официальный Codex App Server поддерживает ChatGPT browser и device-code login,
persistent threads, streaming и `turn/steer`:
[Codex App Server documentation](https://developers.openai.com/codex/app-server).

## Установка на Hetzner

Для нового Ubuntu 24.04 x86-64 VPS обязательно выберите SSH-ключ и вставьте
содержимое [deploy/cloud-init.yaml](deploy/cloud-init.yaml) в поле **Cloud config**
формы создания сервера. Файл устанавливает системные пакеты, Node.js 24 LTS,
Codex CLI, пользователя `summate`, 4 GiB swap, UFW и автоматические security
updates. Секретов в cloud-init нет, сервис автоматически не запускается.

После создания VPS дождитесь bootstrap и загрузите приватный репозиторий вместе
с `.git`:

```bash
summate_server=203.0.113.10
ssh -i ~/.ssh/summing-deploy root@"${summate_server}" 'cloud-init status --wait'
rsync -az \
  --exclude node_modules \
  --exclude dist \
  --exclude .pytest_cache \
  --exclude __pycache__ \
  --exclude '*.pyc' \
  --exclude '/.env' \
  --exclude '/.env.*' \
  --exclude '/.codex' \
  --exclude '/config.toml' \
  --exclude '/summate.env' \
  --exclude '/data' \
  -e "ssh -i ~/.ssh/summing-deploy" \
  ./ root@"${summate_server}":/opt/summate/
ssh -i ~/.ssh/summing-deploy root@"${summate_server}"
```

На VPS заполните `TELEGRAM_BOT_TOKEN` и `TELEGRAM_OWNER_ID`:

```bash
nano /etc/summate/summate.env
/opt/summate/deploy/activate.sh
```

`activate.sh` создаёт production-конфиг, выполняет `npm ci`, lint, тесты и
сборку, оставляет только production dependencies, устанавливает systemd unit и
проверяет локальный health endpoint. Затем отправьте боту `/login` и завершите
ChatGPT device-code flow. Не помещайте Telegram token, OpenAI credentials или
приватный deploy key в cloud-init: user-data сохраняется в metadata провайдера и
самого VPS.

## Ручная установка

```bash
npm ci
npm run build
npm prune --omit=dev
cp deploy/config.production.toml /var/lib/summate/data/config.toml
```

Настройте проекты в `config.toml`, секреты в `/etc/summate/summate.env`, затем
установите [deploy/summate.service](deploy/summate.service). Unit ожидает Node.js
в `/usr/local/bin/node`; при другом способе установки скорректируйте `ExecStart`.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now summate
sudo systemctl status summate
sudo journalctl -u summate -f
curl --fail http://127.0.0.1:8765/health
```

В Telegram:

```text
/login
/projects
/bind <project> [workspace]
/status
```

## Управление

| Команда | Назначение |
|---|---|
| `/login` | ChatGPT device-code login в принадлежащем Summate Codex home. |
| `/projects` | Показать проекты из TOML. |
| `/bind` | Связать текущий topic с Project/Workspace. |
| `/status` | Проверить Codex, account, binding и runs. |
| `/steer` | Добавить указание в активный turn. |
| Reply на stream | То же, без команды. |
| `/cancel` | Прервать активный turn topic. |
| `/new` | Начать новый Codex thread в topic. |
| `/remember` | Добавить факт в общую память проекта. |
| `/review` | Один review текущих изменений. |
| `/restart` | Завершиться с кодом 42; systemd поднимет процесс. |
| `/panic` | Полностью остановиться с кодом 99; systemd не перезапустит. |

## Данные

```text
$SUMMATE_DATA_DIR/
├── config.toml
├── state.sqlite3
├── codex/
├── memory/identity.md
├── projects/<id>/memory.md
└── worktrees/<conversation-id>/
```

Полная архитектура и VPS runbook: [PROJECT_HANDBOOK_RU.md](PROJECT_HANDBOOK_RU.md).
Конституционные принципы: [BIBLE.md](BIBLE.md).

## Тесты

```bash
make test
make lint
```

## License

MIT.
