# Summate 8.3

Summate — один постоянно живущий агент с одним администратором и назначаемыми
владельцами проектов. Он работает на Linux VPS, принимает команды из Telegram
forum topics и исполняет их через общий официальный Codex App Server с
авторизацией ChatGPT subscription администратора.

## Модель

```text
Project
  ├── Owner: Telegram user ID
  ├── Workspace: local Git repository
  └── Conversation: Telegram topic
        ├── Editor Codex thread: administrator / Project owner
        ├── Read-only Codex thread: other group participants
        └── Active run: 0..1
```

- разные Telegram topics выполняются параллельно;
- в одном topic одновременно работает только один run;
- reply на потоковый ответ или `/steer` направляется в активный Codex turn;
- остальные сообщения объединяются в следующий turn;
- каждая conversation получает постоянный Git worktree и ветку;
- project memory общая для всех topics проекта;
- администратор создаёт локальные проекты из личного чата, а владелец видит и
  использует только назначенные ему проекты;
- остальные участники уже привязанного group topic могут задавать вопросы о
  реализации обычными сообщениями, но не могут выполнять slash-команды;
- `@mention` или reply на сообщение бота гарантированно ставит вопрос в
  приоритетную очередь; остальные сообщения анализируются пакетами раз в 20
  секунд, и бот отвечает только когда видит существенную пользу для обсуждения;
- один участник по умолчанию может передать в анализ до 12 сообщений за 60
  секунд; лишний фоновый шум отбрасывается без ответа;
- ответы участникам идут через отдельный persistent read-only thread без записи,
  сети, web search, plugins/connectors и доступа к runtime memory или файлам
  секретов;
- Web UI, CLI, Mini App, Claudexor, swarm, MCP, marketplaces, local models,
  schedules и автономная Evolution отсутствуют.

## Требования

- Linux;
- Node.js 24+ и npm;
- Git;
- установленный `codex` с командой `codex app-server`;
- Telegram bot token;
- Telegram user ID администратора;
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

На VPS заполните `TELEGRAM_BOT_TOKEN` и Telegram ID администратора в
`TELEGRAM_OWNER_ID`:

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
sudo install -d -m 0755 /etc/codex
sudo install -m 0644 deploy/codex-requirements.toml /etc/codex/requirements.toml
```

Настройте статические администраторские проекты в `config.toml`, секреты в
`/etc/summate/summate.env`, затем
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
/project_create client_name 123456789 repo_name
# либо: /project_clone client_name 123456789 repo_name <git_url>
/projects
/bind <project> [workspace]
/status
```

`/project_create` создаёт пустой Git-репозиторий в
`$SUMMATE_DATA_DIR/repositories/<project>/<repo>`. `/project_clone` клонирует
существующий remote туда же. Обе команды принимает только личный чат
администратора; перезапуск не нужен. Не передавайте token в Git URL — настройте
SSH/credential helper для системного пользователя `summate`.
Идентификатор проекта должен соответствовать `[a-z0-9][a-z0-9._-]{0,63}`;
последовательность `..` и окончание `.lock` запрещены, потому что ID входит в
имя рабочей Git-ветки.

Назначенный владелец должен сначала открыть бота и отправить `/start`. После
этого ему доступны `/projects`, `/bind` и рабочие команды его проектов. Все
владельцы используют общий ChatGPT/Codex account администратора, но каждый
Codex-turn получает restricted read roots своего conversation worktree.

После `/bind` любой другой пользователь, который пишет в этом group topic,
получает только Q&A-доступ: бот может читать исходники и объяснять реализацию.
Запросы на изменение кода, запуск сборки/тестов/серверов и другие действия он
отклоняет; технически такой run отделён от рабочего thread владельца и запускается
с read-only filesystem, выключенной сетью и `approvalPolicy = "never"`. Все
slash-команды гостя блокируются runtime до обращения к Codex.

Тегать бота необязательно. Обычные сообщения накапливаются в тихой очереди и
раз в `participant_batch_sec` секунд отправляются одним read-only пакетом на
смысловой анализ. Ответ появляется только на конкретное исходное сообщение,
если оно содержит важный вопрос, вероятную фактическую ошибку, риск, блокер или
решение, которое стоит уточнить. Приветствия, подтверждения, шутки, повторы,
общая болтовня и просьбы выполнить действие остаются без ответа. Упоминание
`@username_бота` или reply на его сообщение обходит ожидание пакета и означает:
«ответь на это обязательно».

Чтобы Summate действительно видел обычные сообщения, в Telegram нужно выполнить
одно из двух условий:

1. сделать бота администратором forum group; или
2. в `@BotFather` выбрать `/setprivacy` → бота → `Disable`, после чего удалить и
   заново добавить бота в группу.

При включённом Privacy Mode не-администратор получает только адресованные ему
команды и replies, поэтому фоновый анализ работать не будет. Это поведение
описано в [официальной документации Telegram](https://core.telegram.org/bots/features#privacy-mode).

## Управление

| Команда | Назначение |
|---|---|
| `/start`, `/help` | Показать подробную Markdown-справку с примерами. |
| `/login` | ChatGPT device-code login; только администратор в личном чате. |
| `/project_create <project> <owner_id> <repo>` | Создать локальный проект; только администратор в личном чате. |
| `/project_clone <project> <owner_id> <repo> <git_url>` | Клонировать проект; только администратор в личном чате. |
| `/projects` | Показать доступные отправителю проекты. |
| `/bind` | Связать текущий topic с Project/Workspace. |
| `/status` | Проверить Codex, account, binding и runs. |
| `/steer` | Добавить указание в активный turn. |
| Reply на stream | То же, без команды. |
| `/cancel` | Прервать активный turn topic. |
| `/new` | Начать новый Codex thread в topic. |
| `/remember` | Добавить факт в общую память проекта. |
| `/review` | Один review текущих изменений. |
| `/restart` | Завершиться с кодом 42; только администратор. |
| `/panic` | Полностью остановиться с кодом 99; только администратор. |

## Данные

```text
$SUMMATE_DATA_DIR/
├── config.toml
├── state.sqlite3
├── codex/
├── memory/identity.md
├── projects/<id>/memory.md
├── repositories/<id>/<repo>/
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
