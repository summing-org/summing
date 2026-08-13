# SUMMING 9.0

SUMMING — один постоянно живущий агент с одним администратором и назначаемыми
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
- `/limits` показывает 5-часовой и недельный остаток именно VPS-аккаунта Codex,
  а short description профиля бота обновляется тем же недельным показателем;
- ответы участникам идут через отдельный persistent read-only thread без записи,
  сети, web search, plugins/connectors и доступа к runtime memory или файлам
  секретов;
- Telegram documents до 20 МБ скачиваются в приватный spool и перед Run
  копируются в исключённый из Git `.summing-runtime/attachments`; ZIP сначала
  инспектируется как архив и не распаковывается автоматически на хосте;
- voice/audio по умолчанию транскрибируются через OpenAI `gpt-transcribe`;
  Groq Whisper доступен как опция, в Codex передаётся только текст, а локальный
  аудиофайл удаляется;
- Project Viewer открывается как Telegram Mini App: показывает дерево, безопасный
  текст файлов, working/commit/run diff, runner jobs и логи;
- отдельный rootless Docker runner собирает неизменяемые Git snapshots и
  выполняет только фиксированные действия `build`, `validate`, `dry-run`, `run`;
- per-project systemd timer может запускать закреплённый commit SHA; merge/push,
  Claudexor, swarm, MCP, marketplaces, local models и автономная Evolution
  отсутствуют.

## Требования

- Linux;
- Node.js 24+ и npm;
- Git;
- `bubblewrap`, AppArmor profile для него, `file` и `unzip`;
- установленный `codex` с командой `codex app-server`;
- Telegram bot token;
- Telegram user ID администратора;
- ChatGPT plan с доступом к Codex;
- OpenAI API key для voice/audio transcription (либо Groq API key при выборе
  Groq-провайдера).

Официальный Codex App Server поддерживает ChatGPT browser и device-code login,
persistent threads, streaming и `turn/steer`:
[Codex App Server documentation](https://developers.openai.com/codex/app-server).

## Установка на Hetzner

Для нового Ubuntu 24.04 x86-64 VPS обязательно выберите SSH-ключ и вставьте
содержимое [deploy/cloud-init.yaml](deploy/cloud-init.yaml) в поле **Cloud config**
формы создания сервера. Файл устанавливает системные пакеты, Node.js 24 LTS,
Codex CLI, пользователя `summing`, 4 GiB swap, UFW и автоматические security
updates. Секретов в cloud-init нет, сервис автоматически не запускается.

После создания VPS дождитесь bootstrap и загрузите приватный репозиторий вместе
с `.git`:

```bash
summing_server=203.0.113.10
ssh -i ~/.ssh/summing-deploy root@"${summing_server}" 'cloud-init status --wait'
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
  --exclude '/summing.env' \
  --exclude '/data' \
  -e "ssh -i ~/.ssh/summing-deploy" \
  ./ root@"${summing_server}":/opt/summing/
ssh -i ~/.ssh/summing-deploy root@"${summing_server}"
```

На VPS заполните `TELEGRAM_BOT_TOKEN`, Telegram ID администратора в
`TELEGRAM_OWNER_ID` и отдельный `OPENAI_API_KEY`:

```bash
nano /etc/summing/summing.env
/opt/summing/deploy/activate.sh
```

`activate.sh` создаёт production-конфиг, выполняет `npm ci`, lint, тесты и
сборку, оставляет только production dependencies, устанавливает systemd units,
атомарный release symlink и проверяет локальный health endpoint. Затем отправьте
боту `/login` и завершите ChatGPT device-code flow. Не помещайте Telegram token,
API credentials или приватный deploy key в cloud-init: user-data сохраняется в
metadata провайдера и самого VPS.

Для автоматических обновлений настройте пользователю `summing` read-only SSH
deploy key к приватному репозиторию и убедитесь, что следующая команда работает
без prompt:

```bash
sudo -u summing env HOME=/var/lib/summing GIT_TERMINAL_PROMPT=0 \
  git -C /opt/summing fetch origin master
```

Ожидаемый URL `origin` закреплён в root-only `/etc/summing/deploy.env`. По
умолчанию это `git@summing.github.com:summing-org/summing.git`; измените
`SUMMING_DEPLOY_EXPECTED_REMOTE`, если VPS использует другой эквивалентный SSH
URL.

## Ручная установка

```bash
npm ci
npm run build
npm prune --omit=dev
cp deploy/config.production.toml /var/lib/summing/data/config.toml
sudo install -d -m 0755 /etc/codex
sudo install -m 0644 deploy/codex-requirements.toml /etc/codex/requirements.toml
```

Настройте статические администраторские проекты в `config.toml`, секреты в
`/etc/summing/summing.env`, затем
установите [deploy/summing.service](deploy/summing.service). Unit ожидает Node.js
в `/usr/local/bin/node`; при другом способе установки скорректируйте `ExecStart`.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now summing
sudo systemctl status summing
sudo journalctl -u summing -f
curl --fail http://127.0.0.1:8765/health
```

В Telegram:

```text
/login
/limits
/project_create client_name 123456789 repo_name
# либо: /project_clone client_name 123456789 repo_name <git_url>
/projects
/bind <project> [workspace]
/status
/files
```

`/project_create` создаёт пустой Git-репозиторий в
`$SUMMING_DATA_DIR/repositories/<project>/<repo>`. `/project_clone` клонирует
существующий remote туда же. Обе команды принимает только личный чат
администратора; перезапуск не нужен. Не передавайте token в Git URL — настройте
SSH/credential helper для системного пользователя `summing`.
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

Документ можно отправить с caption или без него. SUMMING сохранит его внутри
runtime-каталога conversation и передаст Codex точный относительный путь. Архивы
не исполняются и не распаковываются автоматически. Voice, Telegram audio и
аудиодокументы поддерживаемых форматов по умолчанию отправляются в
[OpenAI Transcription API](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)
с моделью `gpt-transcribe`; результат становится обычным текстовым запросом.
Для Groq достаточно выбрать `provider = "groq"`, модель
`whisper-large-v3-turbo` или `whisper-large-v3` и добавить `GROQ_API_KEY`.
Локальная копия аудио удаляется сразу после транскрипции. Аудио покидает сервер
и обрабатывается выбранным API-провайдером; примените подходящие вашей
организации data controls.

Тегать бота необязательно. Обычные сообщения накапливаются в тихой очереди и
раз в `participant_batch_sec` секунд отправляются одним read-only пакетом на
смысловой анализ. Ответ появляется только на конкретное исходное сообщение,
если оно содержит важный вопрос, вероятную фактическую ошибку, риск, блокер или
решение, которое стоит уточнить. Приветствия, подтверждения, шутки, повторы,
общая болтовня и просьбы выполнить действие остаются без ответа. Упоминание
`@username_бота` или reply на его сообщение обходит ожидание пакета и означает:
«ответь на это обязательно».

Чтобы SUMMING действительно видел обычные сообщения, в Telegram нужно выполнить
одно из двух условий:

1. сделать бота администратором forum group; или
2. в `@BotFather` выбрать `/setprivacy` → бота → `Disable`, после чего удалить и
   заново добавить бота в группу.

При включённом Privacy Mode не-администратор получает только адресованные ему
команды и replies, поэтому фоновый анализ работать не будет. Это поведение
описано в [официальной документации Telegram](https://core.telegram.org/bots/features#privacy-mode).

Runtime сохраняет событие `my_chat_member`, поэтому добавленная группа сразу
появляется у администратора в `/topics`. Само событие добавления не содержит
список существующих forum topics: конкретный `topic_id` регистрируется, когда бот
впервые получает сообщение или service-event из этого топика. После этого
администратор может из личного чата выполнить
`/bind_topic <chat_id> <topic_id> <project> [workspace]`. Список и удалённая
привязка недоступны в группах и другим пользователям.

## Управление

| Команда | Назначение |
|---|---|
| `/start`, `/help` | Показать подробную Markdown-справку с примерами. |
| `/login` | ChatGPT device-code login; только администратор в личном чате. |
| `/limits` | Остаток 5-часового и недельного Codex limits на VPS; только администратор в личном чате. |
| `/project_create <project> <owner_id> <repo>` | Создать локальный проект; только администратор в личном чате. |
| `/project_clone <project> <owner_id> <repo> <git_url>` | Клонировать проект; только администратор в личном чате. |
| `/topics` | Показать обнаруженные группы, топики и bindings; только администратор в личном чате. |
| `/bind_topic <chat_id> <topic_id> <project> [workspace]` | Привязать обнаруженный топик из личного чата администратора. |
| `/projects` | Показать доступные отправителю проекты. |
| `/bind` | Связать текущий topic с Project/Workspace. |
| `/status` | Проверить Codex, account, binding и runs. |
| `/files` | Открыть Project Viewer, diff, runner jobs и логи. |
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
$SUMMING_DATA_DIR/
├── config.toml
├── state.sqlite3
├── codex/
├── memory/identity.md
├── projects/<id>/memory.md
├── run-artifacts/<conversation-id>/<run-id>/
├── attachments/<conversation-id>/   # pending private spool
├── repositories/<id>/<repo>/
└── worktrees/<conversation-id>/
```

Полная архитектура и VPS runbook: [PROJECT_HANDBOOK_RU.md](PROJECT_HANDBOOK_RU.md).
Конституционные принципы: [BIBLE.md](BIBLE.md).

## Project Viewer и runner

Viewer всегда слушает только `127.0.0.1:8766`. Без публичного URL его можно
открыть через SSH tunnel; Telegram Mini App требует HTTPS reverse proxy. После
установки Docker/Caddy вызовите отдельный installer с доменом и закреплённой
ревизией проекта:

```bash
SUMMING_VIEWER_DOMAIN=viewer.example.com \
ASH_SEO_REVISION=<full-commit-sha> \
ENABLE_ASH_SEO_TIMER=0 \
sudo /opt/summing/deploy/install-project-operations.sh
```

Installer создаёт отдельного `summing-runner`, rootless Docker с лимитом build
cache 8 ГБ, HTTPS proxy, project config/data и timer unit. Пользователь
`summing` не получает Docker socket. Перед включением live timer замените
placeholders в `/etc/summing-runner/projects/ash-seo.env` и проверьте
`ash-seo.config.json`, затем запустите Validate и Dry run из Viewer.

## Автоматическое обновление SUMMING

`summing-deploy.timer` каждые 10 минут делает `fetch` закреплённого
`origin/master`. Ту же проверку администратор может немедленно запросить во
вкладке **Настройки** Project Viewer. Владельцы назначенных проектов эту вкладку
не видят и deploy API для них возвращает `403`.

Worker никогда не делает `pull`, `reset` или checkout рабочего `/opt/summing`.
Он экспортирует точный remote commit в `/opt/summing-releases/<sha>`, собирает и
тестирует snapshot от отдельного пользователя `summing-builder`, ждёт завершения
активных Codex runs, атомарно переключает `/opt/summing-current` и проверяет
SUMMING и runner. При неуспешном health check symlink и сервисы автоматически
возвращаются на предыдущий release. Non-fast-forward обновления отклоняются.

```bash
systemctl list-timers summing-deploy.timer
systemctl status summing-deploy.service
journalctl -u summing-deploy --since today
sudo systemctl start summing-deploy.service
```

## Тесты

```bash
make test
make lint
```

## License

MIT.
