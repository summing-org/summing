# SUMMING 9.8

SUMMING — один постоянно живущий агент с одним администратором и назначаемыми
владельцами проектов. Он работает на Linux VPS, принимает команды из Telegram
forum topics и исполняет их через общий официальный Codex App Server с
авторизацией ChatGPT subscription администратора.

## Модель

```text
Team Space: создаётся при подключении командного источника
  ├── Sources / topics
  ├── People + provider identities
  ├── Durable event journal
  ├── Evidence-backed knowledge
  ├── Conversation Understanding Loop: episode → memory + silent/reply
  └── Linked Projects
        ├── Owner: Telegram user ID
        ├── Workspace: local Git repository
        └── Conversation: source topic
              ├── Editor Codex thread: administrator / Project owner
              ├── Read-only Codex thread: other group participants
              └── Active run: 0..1
```

- разные Telegram topics выполняются параллельно;
- в одном topic одновременно работает только один run;
- reply на потоковый ответ или `/steer` направляется в активный Codex turn;
- Markdown ответов агента безопасно преобразуется в Telegram HTML: заголовки,
  списки, ссылки, цитаты, выделение, inline-код, code fences и таблицы отображаются
  нативно, а длинные ответы делятся без разрыва форматирующих тегов;
- остальные сообщения объединяются в следующий turn;
- каждая conversation получает постоянный Git worktree и ветку;
- project memory общая для всех topics проекта;
- администратор создаёт локальные проекты из личного чата, а владелец видит и
  использует только назначенные ему проекты;
- остальные участники уже привязанного group topic могут явно упомянуть бота или
  ответить ему и получить read-only Q&A о реализации, но не могут выполнять slash-команды;
- `@mention` или reply на сообщение бота гарантированно ставит вопрос в
  приоритетную очередь; остальные сообщения после source-local quiet window
  проходят один Conversation Understanding Loop, который одновременно строит
  episode, обновляет память и выбирает `silent` либо полезный reply;
- сообщение администратора или Project owner, явно адресованное другому человеку
  через ведущий `@mention` или reply, считается фоновой беседой, а не editor-командой:
  оно не запускает и не steer-ит Project run, а остаётся evidence общего loop;
- технический `reply_to_message` на корневое service-message Telegram forum topic
  игнорируется при определении адресата. Для настоящего reply Codex получает bounded
  безопасную цепочку из ближайшей Telegram-цитаты и её сохранённых предков. Уже
  обогащённый текст ближайшего события, включая однократно созданную транскрипцию
  аудио, повторно используется из evidence journal без скачивания файла; одинокий
  `@mention` в reply означает просьбу проследить ссылки вроде «вот» и разобрать самый
  глубокий содержательный контекст. Упоминание, добавленное через edit, также становится direct;
- приглашение в группу сразу создаёт Team Space; доступные Bot API messages,
  edits, reactions и membership events долговременно фиксируются до rate limit и
  решения об ответе, даже если topic ещё не привязан к Project;
- bind связывает Project с уже накопленным Team Space и не уничтожает evidence;
- автоматическая отправка фоновой переписки в Codex для Conversation Understanding
  требует отдельного явного operator consent и `team_memory.model_egress_enabled = true`;
  без него journal остаётся локальным;
- `@mention` или reply в projectless source запускает прежний bounded read-only
  ответ без доступа к файлам, памяти и истории любого Project;
- `/memory`, `/memory_me`, `/memory_forget_me` и `/memory_resume_me` делают
  наблюдение прозрачным и управляемым для участников;
- один участник по умолчанию может явно обратиться к боту до 12 раз за 60 секунд;
  background evidence сохраняется до применения лимита и ограничивается batching/capacity;
- `/limits` показывает 5-часовой и недельный остаток именно VPS-аккаунта Codex,
  а short description профиля бота обновляется тем же недельным показателем и
  текущей версией SUMMING;
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
  текст файлов, working/commit/run diff, состояние `origin`, безопасные Pull/Push
  текущей ветки и явную fast-forward публикацию её `HEAD` в `origin/master`,
  runner jobs, логи и простой dotenv-editor;
- отдельный администраторский Mini App открывается постоянной кнопкой
  **Управление** в личном чате: показывает проекты и обнаруженные Telegram-топики,
  сводит наблюдаемых пользователей по группе и топикам с Telegram ID и активностью,
  создаёт или клонирует управляемые репозитории и выполняет bind/rebind без ручного
  ввода `chat_id`, `topic_id` и slash-команд, а в системных настройках показывает
  фазу и историю deployment, упавшие тесты и безопасный хвост журнала, а также
  позволяет запросить обновление SUMMING; после новой привязки
  бот упоминает владельца проекта в выбранном топике и сообщает Project/Repository;
- отдельный rootless Docker runner собирает неизменяемые Git snapshots и
  выполняет только фиксированные действия `build`, `validate`, `dry-run`, `run`;
- per-project systemd timer может запускать закреплённый commit SHA; автоматические
  commit/merge/push, force push, Claudexor, swarm, MCP, marketplaces, local models
  и автономная Evolution отсутствуют.

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

В Telegram основным администраторским интерфейсом служит кнопка **Управление**.
Один раз отправьте `/start`, чтобы бот установил menu button и показал inline-кнопку.
После этого создавайте проекты и привязки forum topics в Mini App. Топик появляется
там после первого сообщения, которое увидел бот. Там же можно раскрыть сводку по
наблюдаемым авторам группы или отдельного топика: имя, username, Telegram ID, язык,
bot/premium flags, число сообщений и первое/последнее наблюдение. Telegram Bot API
не перечисляет молчащих участников, поэтому это не полный membership list. Раздел
**Настройки SUMMING** в этом же Mini App содержит глобальное обновление приложения;
Project Viewer остаётся интерфейсом конкретного Project/Repository.

Команды остаются совместимым резервным путём:

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
администратора; перезапуск не нужен. Для `/project_clone` не передавайте token в
Git URL — заранее настройте SSH/credential helper для системного пользователя
`summing`. Репозиторий из `/project_create` можно позднее подключить к SSH
`origin` встроенным мастером во вкладке **Репозиторий**.
Идентификатор проекта должен соответствовать `[a-z0-9][a-z0-9._-]{0,63}`;
последовательность `..` и окончание `.lock` запрещены, потому что ID входит в
имя рабочей Git-ветки.

Назначенный владелец должен сначала открыть бота и отправить `/start`. После
этого ему доступны `/projects`, `/bind` и рабочие команды его проектов. Все
владельцы используют общий ChatGPT/Codex account администратора, но каждый
Codex-turn получает roots своего conversation worktree. Write-run владельца также
получает только project-scoped общий Git directory linked worktree, поэтому может
выполнять обычные `fetch`, commit и rebase; read-only run участника этот root не получает.

После `/bind` любой другой пользователь, который пишет в этом group topic,
получает только Q&A-доступ: бот может читать исходники и объяснять реализацию.
Запросы на изменение кода, запуск сборки/тестов/серверов и другие действия он
отклоняет; технически такой run отделён от рабочего thread владельца и запускается
с read-only filesystem, выключенной сетью и `approvalPolicy = "never"`. Все
slash-команды гостя блокируются runtime до обращения к Codex.

Непривязанный group topic не становится Conversation, но сразу становится источником
Team Space. Обычная беседа в нём пополняет локальный долговечный журнал evidence,
не запускает Codex и не порождает служебное сообщение о `/bind`. Если
участник явно упомянул `@username_бота` или ответил на сообщение бота, SUMMING
запускает свежий общий Q&A без Project/Workspace, файлов, project memory, сети и
внешних интеграций. Встроенная shell-команда технически остаётся доступна только для
read-only inspection отдельного пустого CWD; Project через неё не виден. Если сообщение
содержит только `@mention` без вопроса, бот локально просит написать вопрос и не создаёт
Codex thread, не расходует participant quota и не добавляет такой ping в контекст.
Для содержательного вопроса thread создаётся как ephemeral, App Server environments
отключаются, а runtime отписывается после ответа,
поэтому не сохраняет orphaned history или подписку. Вопрос получает контекст из
последних двадцати видимых отправителю записей журнала, а reply также включает текст
ответа бота, на который ссылается пользователь; вложения в непривязанном топике не
скачиваются. Журнал переживает перезапуск. Credential-подобный текст удаляется и
аудитируется даже в фоновой
беседе; при успешном удалении бот молчит, а при ошибке просит удалить его вручную.
Projectless Q&A имеет отдельную от Project Conversation очередь: один активный ответ и
не более четырёх активных/ожидающих вопросов суммарно. Зависший turn прерывается через
две минуты и освобождает очередь.

При `team_memory.model_egress_enabled = true` pending evidence одного Source после
`team_memory.understanding_quiet_sec` секунд тишины отправляется bounded-пакетом в
отдельный ephemeral read-only Codex thread без Project, файлов, сети, environments и
внешних инструментов. Quiet timer сбрасывается новым событием, но
`understanding_max_wait_sec` гарантирует обработку непрерывной беседы, а
`understanding_max_events` запускает заполненный batch немедленно.

Один structured output содержит Conversation Episode, обновлённый summary,
evidence-backed knowledge и `silent/reply` decision. Runtime принимает его только после
проверки полноты episode, Source/Person boundaries, evidence ids, confidence,
visibility, temporal validity, supersession links и reply target. Отдельного Project
ambient model call нет. До первого batch Team Space получает уведомление о составе
model egress; после `team_memory.orientation_event_threshold` событий SUMMING один раз
показывает понимание и уточняет главные пробелы. Дальнейшие replies ограничены
`team_memory.intervention_cooldown_sec` и всегда привязаны к конкретному provider message.

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

В уже привязанном топике тегать бота необязательно. Обычные сообщения сразу становятся
Team Space evidence и после adaptive quiet window входят в единый read-only Conversation
Understanding batch. Ответ появляется только на конкретное исходное сообщение,
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
| `/status` | Проверить версию SUMMING, Codex, account, binding и runs. |
| `/files` | Открыть Project Viewer, Git Pull/Push, diff, runner jobs и логи. |
| `/steer` | Добавить указание в активный turn. |
| Reply на stream | То же, без команды. |
| `/cancel` | Прервать активный turn topic. |
| `/new` | Начать новый Codex thread в topic. |
| `/remember` | Добавить факт в общую память проекта. |
| `/memory`, `/memory_status` | Показать состояние и видимые знания Team Space. |
| `/memory_me` | Показать собственные сохранённые события и связанные выводы. |
| `/memory_forget_me`, `/memory_resume_me` | Удалить свои данные и остановить/возобновить будущий ingest. |
| `/memory_pause`, `/memory_resume` | Приостановить/возобновить Team Space; только администратор. |
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
Team Space, evidence и privacy lifecycle: [TEAM_MEMORY_RU.md](TEAM_MEMORY_RU.md).
Project `.env`, шифрование и runtime injection: [ENVIRONMENTS_RU.md](ENVIRONMENTS_RU.md).

## Project Viewer и runner

Viewer всегда слушает только `127.0.0.1:8766`. Без публичного URL его можно
открыть через SSH tunnel; Telegram Mini App требует HTTPS reverse proxy. После
установки Docker/Caddy вызовите отдельный installer с доменом и закреплённой
ревизией проекта:

```bash
SUMMING_VIEWER_DOMAIN=assist.summing.org \
SUMMING_VIEWER_REDIRECT_DOMAIN=ash.summing.org \
ASH_SEO_REVISION=<full-commit-sha> \
ENABLE_ASH_SEO_TIMER=0 \
sudo /opt/summing/deploy/install-project-operations.sh
```

Installer создаёт отдельного `summing-runner`, rootless Docker с лимитом build
cache 8 ГБ, приватный AES-ключ для project env, HTTPS proxy, project config/data
и timer unit. Пользователь `summing` не получает Docker socket. При первом
переходе static env и raw credentials из legacy Connections автоматически
объединяются в encrypted store. Затем runner выполняет Validate и Dry run на
одной env revision; только успешная проверка разрешает следующему deploy tick
убрать Connections route и отключить broker. Legacy vault и recovery-копии
config/unit/Caddyfile сохраняются для rollback. После cutover редактируйте
значения во вкладке **Энвы**. Полный протокол: [ENVIRONMENTS_RU.md](ENVIRONMENTS_RU.md).
Основной production URL Mini App — `https://assist.summing.org`; прежний
`https://ash.summing.org` остаётся только постоянным HTTPS-редиректом с
сохранением URI для уже отправленных Telegram-кнопок.

Вкладка **Репозиторий** доступна администратору и назначенному owner. Она
показывает текущую conversation-ветку и её состояние относительно `origin`.
**Push** отправляет только уже существующие commits в одноимённую remote-ветку,
никогда не использует force и не включает dirty working tree. **Pull** сначала
обновляет remote refs и меняет локальную ветку только чистым fast-forward: при
незакоммиченных или разошедшихся изменениях операция останавливается без merge,
rebase или reset. Для private remote заранее настройте non-interactive write
credentials пользователя `summing` либо используйте встроенный SSH-мастер.

Отдельная кнопка **Отправить в origin/master** доступна тому же owner и
администратору. Перед подтверждением Viewer показывает текущий `HEAD`, актуальный
`origin/master` и число публикуемых commits. Backend повторно делает fetch,
сверяет оба полных SHA и разрешает только fast-forward точного текущего `HEAD`
при чистом working tree. Кнопка не создаёт отсутствующий `master`, merge commit,
reset или force-push; если remote успел измениться, требуется обновить состояние
и подтвердить публикацию заново.

Если `origin` отсутствует, owner вставляет SSH URL вида
`git@github.com:owner/repository.git`. SUMMING один раз добавляет `origin`,
создаёт отдельный Ed25519 deploy key для Project repository и показывает в API
и интерфейсе только публичную часть. Добавьте её в Git-сервис с write-доступом и
нажмите **Проверить чтение и запись**. Чтение проверяется через `ls-remote`, а
право записи — безопасным `push --dry-run`, который не создаёт ветки. Интерфейс
сохраняет время последней проверки и показывает точную категорию ошибки: DNS,
сеть, host key, аутентификация, отсутствие repository или запрет записи.
Для существующего SSH remote без credentials мастер умеет создать ключ отдельно.
Приватный ключ и изолированный `known_hosts` лежат вне repository/worktree в
`$SUMMING_DATA_DIR/repository-credentials/<project>/<workspace>/`. Первый SSH
host key принимается по TOFU, после чего его изменение блокируется.

Текущий URL `origin` виден всегда. Его можно заменить только после успешной
предварительной read/write-проверки нового URL и явного подтверждения; если
последующий fetch не проходит, SUMMING автоматически возвращает прежний URL.
После успешной замены в интерфейсе остаётся одношаговый rollback. Управляемый
deploy key ротируется в два этапа: новый ключ сначала добавляется и проверяется,
пока старый продолжает работать, и лишь затем активируется. Старый project-local
`core.sshCommand` не исполняется и удаляется отдельной миграцией только после
успешной проверки управляемого ключа. Подключения, проверки, Pull/Push, публикации
в `origin/master`, смены URL и ротации записываются в ограниченный журнал с actor,
временем, branch и HEAD.

Существующие внешние SSH и HTTPS URL без embedded token продолжают работать;
repository-local hooks, command filters, credential helpers, SSH overrides и
URL rewrites намеренно не исполняются host-сервисом. Для внешнего режима
настраивайте ключ или helper глобально для Unix user `summing`.

## Переход существующего 8.x VPS на SUMMING 9.0

Переименование GitHub repository в `summing-org/summing` должно быть завершено
**до** миграции. Полный VPS snapshot настоятельно рекомендуется, но оператор
может явно отказаться от него и принять более сложное ручное восстановление
только из server-local recovery bundle. Обычный automatic deploy не может
пересечь 9.0 boundary: users, paths, environment variables и units уже имеют
новые имена.

Сначала обновите только чистый mutable checkout до опубликованного `master`, не
трогая активный release, затем запустите read-only preflight:

```bash
legacy_name="sum""mate"
legacy_repo="/opt/${legacy_name}"
sudo -u "${legacy_name}" git -C "${legacy_repo}" fetch origin master
sudo -u "${legacy_name}" git -C "${legacy_repo}" merge --ff-only origin/master
sudo "${legacy_repo}/deploy/migrate-host-to-summing" --check
```

После успешного preflight выполните одноразовый переход одним из двух способов:

```bash
# Рекомендуемый вариант после проверки VPS snapshot:
sudo env SUMMING_BACKUP_CONFIRMED=1 \
  "${legacy_repo}/deploy/migrate-host-to-summing" --apply

# Осознанный отказ от snapshot с принятием риска:
sudo env SUMMING_SNAPSHOT_WAIVED=1 \
  "${legacy_repo}/deploy/migrate-host-to-summing" --apply
```

Нельзя задавать оба флага одновременно. Выбранный режим записывается в manifest
recovery bundle для последующего аудита.

Migration отказывается работать при активных Codex runs, deployment worker,
конфликтующих users/paths/project IDs или недоступном новом remote. Перед
изменениями она останавливает services и сохраняет root-only recovery bundle в
`/var/backups/summing-host-migration-<UTC>`, включая конфигурацию, SQLite backup,
старые units и releases. Этот bundle создаётся в обоих режимах. Затем migration
переносит Unix identities и durable paths,
обновляет SQLite/Git worktree metadata и conversation branches без удаления
незакоммиченных файлов, запускает штатный `activate.sh` и проверяет health.

## Автоматическое обновление SUMMING

`summing-deploy.timer` каждые 10 минут делает `fetch` закреплённого
`origin/master`. Ту же проверку администратор может немедленно запросить в разделе
**Настройки SUMMING** Mini App **Управление**. Deployment API не требует Project или
Conversation и возвращает `403` любому пользователю, кроме администратора.

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
