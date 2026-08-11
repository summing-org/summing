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

## Установка

```bash
npm ci
npm run build
npm prune --omit=dev
cp config.example.toml /var/lib/summate/data/config.toml
```

Настройте проекты в `config.toml`, секреты в `/etc/summate/summate.env`, затем
установите [deploy/summate.service](deploy/summate.service).

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
