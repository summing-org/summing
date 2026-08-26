# SUMMING 9.20

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
- после завершения direct Run предыдущие сообщения Codex с фазой `commentary`
  остаются после финального ответа в свёрнутом блоке **«Ход работы · …»**;
  reasoning, параметры инструментов и вывод команд в этот блок не попадают, а
  журнал ограничен последними 12 000 символами;
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
  а short description профиля бота показывает компактную строку
  `SUMMING <версия> · Codex: <остаток> · до <сброс>`;
- ответы участникам идут через отдельный persistent read-only thread без записи,
  сети, web search, plugins/connectors и доступа к runtime memory или файлам
  секретов;
- Telegram-фото и documents до 20 МБ скачиваются в приватный spool и перед Run
  копируются в исключённый из Git `.summing-runtime/attachments`; фотографии
  передаются Codex как visual input, HEIC/HEIF предварительно преобразуются в JPEG,
  а ZIP сначала инспектируется как архив и не распаковывается автоматически на хосте;
- готовые документы editor-run складывает в `.summing-runtime/outbox`, после чего
  runtime проверяет обычный файл, symlink/hardlink boundary, число и совокупный
  размер и отправляет его пользователю через Telegram `sendDocument`;
- voice/audio по умолчанию транскрибируются через OpenAI `gpt-transcribe`;
  Groq Whisper доступен как опция, в Codex передаётся только текст, а локальный
  аудиофайл удаляется;
- Project Viewer открывается как Telegram Mini App: показывает дерево, безопасный
  текст файлов, working/commit/run diff, состояние `origin`, безопасные Pull/Push
  текущей ветки и явную безопасную публикацию её `HEAD` в основную ветку origin,
  отдельно desired-state services и конечные runner jobs, их логи, аварийную
  остановку job и простой dotenv-editor; вкладка **Правки
  агента** показывает Codex diff, а **Раннер** остаётся диагностическим экраном
  services/jobs/logs/artifacts без зашитых кнопок deployment, запуска и расписания;
- отдельный администраторский Mini App открывается постоянной кнопкой
  **Управление** в личном чате: показывает проекты и обнаруженные Telegram-топики,
  сводит наблюдаемых пользователей по группе и топикам с Telegram ID и активностью,
  создаёт или клонирует управляемые репозитории и выполняет bind/rebind без ручного
  ввода `chat_id`, `topic_id` и slash-команд, а в системных настройках показывает
  фазу и историю deployment, упавшие тесты и безопасный хвост журнала, а также
  позволяет запросить обновление SUMMING. Для каждого Project/Workspace выбирается
  один основной рабочий топик и любое число read-only топиков-наблюдателей;
- отдельный rootless Docker runner собирает неизменяемые Git snapshots и явно
  разделяет конечные jobs (`build`, `validate`, `dry-run`, `run`) и долгоживущие
  именованные services, активируемые из точного завершённого Release;
- owner управляет runner jobs, расписаниями, services и артефактами обычными сообщениями
  агенту. Раздельные host-scoped namespaces `runner` и `service` дают live-state только текущего
  Project/Workspace: запуск и остановка требуют явной команды, расписания хранят
  timezone/дни/время и не допускают overlap, а изменение/удаление расписания и
  удаление/очистка артефактов используют отдельное подтверждение в следующем
  сообщении. Автоматические commit/merge/push, force push, Claudexor, swarm,
  произвольные MCP/marketplaces, local models и автономная Evolution отсутствуют.
- основной топик — единственное место Project/Workspace, где owners и Codex запускают
  изменения. Топик-наблюдатель всегда read-only даже для owner: прямое упоминание или
  reply открывает Q&A по опубликованному снимку Project и локальной истории, а обычный
  комментарий становится недоверенным feedback. Последние consent-visible комментарии
  bounded-пакетом добавляются к следующему owner-run, но никогда автоматически не
  превращаются в требования, решения или задачи. `/publish <обновление>` явно и
  одинаково публикует безопасный текст во все observer-топики текущего Workspace;
- Git-worktree наблюдателя перед Q&A fast-forward-ится к опубликованному `HEAD`
  исходного Project checkout и отказывается продолжать при divergence или локальных
  изменениях. Надёжный transport остаётся внутренней инфраструктурой: targeted replies,
  входящие файлы и legacy runner-маршруты по-прежнему используют логические `portalKey`,
  но ключ/default больше не входят в обычный bind UI. Сообщение сначала попадает в ограниченную
  постоянную outbox-очередь с idempotency key, SHA-256, retry/dead-letter и
  администраторскими Retry/Cancel. Рестарт во время отправки создаёт `uncertain`,
  который никогда не повторяется автоматически. Входящие файлы после secret scan
  хранятся AES-256-GCM до raw-retention и доступны только авторизованному Project
  turn по `artifactId`. Dry-run использует тот же транспорт через обычный
  `portal-messages.json` с необязательным legacy `portalKey`, без report bridge, кнопок
  согласования и callback state machine.

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

Локальные version managers читают Node major из `.node-version`. Все npm
lifecycle-команды дополнительно выполняют быстрый runtime guard и завершаются до
сборки или тестов, если активен Node.js ниже 24.

Официальный Codex App Server поддерживает ChatGPT browser и device-code login,
persistent threads, streaming и `turn/steer`:
[Codex App Server documentation](https://developers.openai.com/codex/app-server).

## Установка на Hetzner

Для новой production-инсталляции используйте
[fresh installer](FRESH_INSTALL_RU.md). Он разделён на provisioning, secure
bootstrap и owner-only интерактивный onboarding. Terraform root создаёт
защищённый Ubuntu 24.04 host и firewall; cloud-init устанавливает Node 24, Codex,
Caddy и системные зависимости без прикладных секретов:

```bash
cd infra/hetzner
cp terraform.tfvars.example terraform.tfvars
export HCLOUD_TOKEN=...
terraform init && terraform apply
```

После DNS и заполнения приватного `deploy/fresh-install.example.json` установка
выполняется из чистого trusted checkout одной командой:

```bash
chmod 0600 /secure/path/fresh-install.json /secure/path/source-deploy-key
deploy/install-fresh \
  --target root@SERVER \
  --identity ~/.ssh/summing-deploy \
  --secrets /secure/path/fresh-install.json \
  --source-key /secure/path/source-deploy-key
```

Если Ubuntu 24.04 уже установлен через Hetzner **Rebuild**, но Cloud Config не
применялся, добавьте `--provision`. Installer подготовит чистый host по SSH и
продолжит установку; изменившийся после rebuild SSH fingerprint всё равно нужно
предварительно сверить через Hetzner Console.

Installer передаёт проверенный bundle текущего commit, закрепляет read-only Git
origin для будущих atomic updates, формирует конфигурацию с закрытыми правами,
запускает lint/test/build, systemd и health check, после чего уничтожает копии
одноразовых inputs в `/run`. Он отказывается работать поверх существующего
durable state. Затем владелец завершает `/login` и видит последовательность
MTProto → согласия → первый sync в **Управление → База знаний**.

## Ручная установка

```bash
npm ci
npm run build
npm prune --omit=dev
cp deploy/config.production.toml /var/lib/summing/data/config.toml
sudo deploy/provision-self-project-worktree
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

Каждый назначенный owner должен сначала открыть бота и отправить `/start`. После
этого ему доступны `/projects`, `/bind` и рабочие команды его проектов. У каждого
управляемого Project есть один обязательный **primary owner** для уведомлений и
любое число совладельцев с теми же рабочими правами. Глобальный администратор
меняет primary, добавляет и удаляет owners в карточке проекта в Admin Mini App.
Там же он может отвязать Project/Workspace от отдельного Telegram-топика без
удаления самого топика из обнаруженного реестра. Отвязка блокируется, пока у
привязки есть активная или ожидающая задача, а после подтверждения удаляет её
локальный Codex-контекст и историю запусков.
Все владельцы используют общий ChatGPT/Codex account администратора, но каждый
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
Background loop использует собственные `team_memory.model` и `team_memory.effort`,
по умолчанию `gpt-5.6-luna`/`low`, поэтому выбор модели основных coding-turns не
меняется. Производственные defaults объединяют bursts в более крупные batch: 60 секунд
тишины, hard deadline 300 секунд и до 100 событий одного Source.
Системный раздел Admin Mini App позволяет включать/выключать model egress без
рестарта; durable override имеет приоритет над config default. Там же показываются
credits отдельных background threads и помеченная `≈` наблюдаемая доля недельного
лимита, рассчитанная по приросту общего weekly indicator вокруг этих turns.
Отдельный `team_memory.proactive_replies_enabled` и соседний Admin-переключатель
управляют только model-generated репликами: при выключенных проактивных ответах
Conversation Understanding Loop продолжает собирать эпизоды и обновлять background
memory, пока включён сам model egress.

Один structured output содержит Conversation Episode, обновлённый summary,
evidence-backed knowledge и `silent/reply` decision. Runtime принимает его только после
проверки полноты episode, Source/Person boundaries, evidence ids, confidence,
visibility, temporal validity, supersession links и reply target. Отдельного Project
ambient model call нет. До первого batch Team Space получает уведомление о составе
model egress; после `team_memory.orientation_event_threshold` событий SUMMING один раз
показывает понимание и уточняет главные пробелы. Дальнейшие replies ограничены
`team_memory.intervention_cooldown_sec` и всегда привязаны к конкретному provider message.
Сообщение, маршрутизированное в direct Project-turn, синхронно получает локальный
`direct_claimed_at`; оно остаётся evidence для памяти, но runtime запрещает orientation
или proactive reply по этому событию и повторно проверяет claim непосредственно перед
Telegram send. Этот routing-факт не экспортируется как Team Knowledge.

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
`/bind_topic <chat_id> <topic_id> <project> [workspace]` для primary либо
`/bind_observer_topic <chat_id> <topic_id> <project> [workspace]` для observer.
Список и удалённая привязка недоступны в группах и другим пользователям.

## Управление

| Команда | Назначение |
|---|---|
| `/start`, `/help` | Показать подробную Markdown-справку с примерами. |
| `/login` | ChatGPT device-code login; только администратор в личном чате. |
| `/limits` | Остаток 5-часового и недельного Codex limits на VPS; только администратор в личном чате. |
| `/project_create <project> <primary_owner_id> <repo>` | Создать локальный проект; только администратор в личном чате. |
| `/project_clone <project> <primary_owner_id> <repo> <git_url>` | Клонировать проект; только администратор в личном чате. |
| `/topics` | Показать обнаруженные группы, топики и bindings; только администратор в личном чате. |
| `/bind_topic <chat_id> <topic_id> <project> [workspace]` | Назначить основной рабочий топик из личного чата администратора. |
| `/bind_observer_topic <chat_id> <topic_id> <project> [workspace]` | Привязать read-only топик-наблюдатель. |
| `/projects` | Показать доступные отправителю проекты. |
| `/bind` | Связать текущий topic с Project/Workspace. |
| `/status` | Проверить версию SUMMING, Codex, account, binding и runs. |
| `/sync_status [chat_id]` | Краткий статус всех knowledge-sync источников или подробный статус группы; только администратор в личном чате. |
| `/files` | Открыть Project Viewer, Git Pull/Push, diff, runner jobs и логи. |
| `/steer` | Добавить указание в активный turn. |
| `/publish <обновление>` | Из primary опубликовать безопасный текст всем observers текущего Workspace. |
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
├── state.sqlite3                  # существующие Team Space events и agent state
├── core.sqlite                    # sync, consent, jobs, objects и canonical blocks
├── search.sqlite                  # восстанавливаемые FTS5/sqlite-vec индексы
├── runner-control.sqlite3         # расписания, исполнения, планы подтверждения и audit
├── node-recovery.sqlite3          # durable export/restore jobs
├── node-id                        # стабильная идентичность recovery-ноды
├── codex/
├── memory/identity.md
├── projects/<id>/memory.md
├── run-artifacts/<conversation-id>/<run-id>/
├── attachments/<conversation-id>/   # pending private spool
├── repositories/<id>/<repo>/        # includes durable SUMMING integration master
└── worktrees/<conversation-id>/
```

Постоянная библиотека Telegram включается секцией `[knowledge_sync]`. В
production одновременно обязательны `telegram_terms_reviewed = true`,
S3-совместимый backend и отдельный 32-байтовый MTProto master key. Подключение
аккаунта, фиксация согласий авторов и allowlist групп выполняются во вкладке
**База знаний** Admin Mini App. `core.sqlite` и объектное хранилище являются
источником истины для нового pipeline; `search.sqlite` полностью
восстанавливается из canonical blocks и versioned embeddings. MTProto-коннектор
остаётся активным после backfill и удаляется только отдельным подтверждённым
отзывом после отвязки всех групп.

Во вкладке **База знаний** доступен versioned export/import целой Team Space.
Формат `summing-team-space-transfer` v2 выбирается по `spaceId` и включает все
источники пространства, участников, события и ревизии, согласия, неизвестных
авторов, synthesis-аудит, interventions, project links, checkpoints, canonical
документы и evidence. `manifest` сохраняет ссылки на уже существующие объекты,
не дублируя файлы. `portable` дополнительно копирует каждый оригинал в
export-prefix с AES-256-GCM и подходит для другой VPS или другого S3-prefix.

При создании bundle Mini App один раз показывает отдельный 32-байтовый recovery
key. В durable job хранится только его AES-GCM envelope, зашифрованный локальным
`/etc/summing/kb-transfer.key`; поэтому серверный ключ копировать на другую VPS
не нужно. Для import нужны S3 object key manifest и сохранённый recovery key.
Импорт проходит HMAC/checksum verification и dry-run, после чего требует явно
принять consent-записи; локальный revoke имеет приоритет. Связанные project IDs
показываются как зависимости, которые нужно сопоставить или provision на целевой
ноде. Коннекторы, MTProto-сессии, operational queues и Project Portal outbox в
Team Space bundle не входят,
а `search.sqlite` пересобирается из импортированного canonical-слоя. После import
Telegram-источники явно перепривязываются к локальному MTProto-коннектору.

### Node recovery и переустановка VPS

Team Space bundle и node recovery решают разные задачи. Team Space переносит
бизнес-библиотеку между нодами. Формат `summing-node-recovery` v1 восстанавливает
состояние конкретной ноды после rebuild: основной SQLite без физической копии
Team Space, runner-control, conversations, identity/project memory, Codex session
JSONL, run artifacts, attachments, Project Portal outbox, зашифрованные входящие
portal-artifacts и Git workspaces. Ключ portal-artifacts относится к secrets и
попадает только в export с `INCLUDE SECRETS`. Каждый workspace представлен Git bundle,
отдельными staged/working binary patches и untracked-файлами; дополнительно
обнаруживаются Git-каталоги в managed repository/worktree roots, даже если они
уже не перечислены в project catalog. `node_modules`, `dist` и caches не архивируются.

Recovery состоит из независимо зашифрованных AES-256-GCM компонентов. Manifest
с HMAC и checksums загружается в S3 последним и является commit marker. В него
входят только object keys уже созданных Team Space bundle — сами события,
документы и content-addressed S3 originals второй раз не копируются. Codex
`auth.json`, GitHub OAuth и внешние OAuth tokens всегда исключены. При выборе
**«Включить секреты»** дополнительно сохраняются SUMMING env/config, локальные
ключи, MTProto connector metadata/TDLib session, repository credentials и
project environments, полученные через runner и зашифрованные внутри recovery.

В **Управление → Система → Node recovery** создание export требует S3 и один раз
показывает отдельный recovery key. Job должен перейти в `succeeded`; сохраните
и `bundleKey`, и recovery key вне VPS. Restore сначала выполняет полный dry-run,
классифицирует Codex sessions как `resumable`, `archive_only` или
`broken_dependency` и только после отдельного подтверждения создаёт staging,
не меняя рабочие данные.

После fresh install на rebuilt VPS повторная root-активация скачивает компоненты
напрямую из S3 и заново проверяет HMAC, SHA-256, AES-GCM и внутренние file hashes.
Recovery key читается из `/dev/tty` без аргумента процесса:

```bash
sudo restore-node-recovery \
  --bundle 'summing/node-recovery/<node-id>/<backup-id>/manifest.json'
```

Команда останавливает SUMMING и runner, создаёт root-only rollback в
`/var/backups/summing-node-recovery-*`, восстанавливает разрешённые пути
транзакционно и запускает services только после успеха. При ошибке выполняется
file rollback, а services остаются остановленными для проверки. После запуска
нужно заново авторизовать Codex/OAuth, импортировать указанные в manifest Team
Space bundle и проверить/reconcile их MTProto bindings. Старый VPS нельзя
rebuild/delete, пока node-recovery job не завершился, ключи не сохранены и хотя
бы dry-run не подтвердил целостность.

Полная архитектура и VPS runbook: [PROJECT_HANDBOOK_RU.md](PROJECT_HANDBOOK_RU.md).
Конституционные принципы: [BIBLE.md](BIBLE.md).
Team Space, evidence и privacy lifecycle: [TEAM_MEMORY_RU.md](TEAM_MEMORY_RU.md).
Project `.env`, шифрование и runtime injection: [ENVIRONMENTS_RU.md](ENVIRONMENTS_RU.md).

## Project Viewer и runner

Viewer всегда слушает только `127.0.0.1:8766`. Без публичного URL его можно
открыть через SSH tunnel; Telegram Mini App требует HTTPS reverse proxy. После
установки Docker/Caddy вызовите отдельный generic installer с доменом:

```bash
SUMMING_VIEWER_DOMAIN=assist.summing.org \
SUMMING_VIEWER_REDIRECT_DOMAIN=old-assist.example.org \
sudo /opt/summing/deploy/install-project-operations.sh
```

Installer создаёт отдельного `summing-project-runner`, rootless Docker с лимитом build
cache 8 ГБ, приватный AES-ключ для project env и HTTPS proxy. Project profiles
регистрируются самим SUMMING и не создаются installer-ом по встроенному имени.
Для managed Project `config.json` и `config.example.json` являются
необязательными: если в выбранной revision нет ни одного файла, Release получает
безопасный пустой `{}` config. Статические root-managed profiles остаются
строгими и завершают job ошибкой при отсутствии указанного `configSourcePaths`.
Имя, socket и state отделены от
внешних runner-сервисов узла; существующий `summing-runner.service` не изменяется.
Пользователь `summing` не получает
Docker socket. При первом
переходе static env и raw credentials из legacy Connections автоматически
объединяются в encrypted store. Затем runner выполняет Validate и Dry run на
одной env revision; только успешная проверка разрешает следующему deploy tick
убрать Connections route и отключить broker. Legacy vault и recovery-копии
config/unit/Caddyfile сохраняются для rollback. После cutover редактируйте
значения во вкладке **Энвы**. Полный протокол: [ENVIRONMENTS_RU.md](ENVIRONMENTS_RU.md).
Необязательный redirect-domain остаётся постоянным HTTPS-редиректом с сохранением
URI для уже отправленных Telegram-кнопок.

Project-specific timer никогда не выбирается по имени автоматически. Если на
конкретном VPS остался старый unit, передайте его точный basename явно, без
`.service`/`.timer`: `SUMMING_LEGACY_PROJECT_UNIT=summing-project-a`. Installer
сначала поднимет и проверит generic runner, затем отключит только
`summing-project-a.timer` и остановит `summing-project-a.service`. Legacy
environment cutover аналогично выполняется только с явно заданным
`SUMMING_ENV_MIGRATION_PROJECT`; без него deploy ничего не угадывает и пропускает
миграцию.

Запуском теперь управляет сам агент через закрытый namespace раннера. На вопросы
вроде «что сейчас крутится?», «что с раннером?» или «что запланировано?» он
обязан сначала прочитать live jobs, последние результаты, расписания и доступные
артефакты, а при необходимости — ограниченный хвост job log, не угадывая состояние
по процессам или файлам. По явной команде owner агент
может запустить Build/Validate/Dry run/Live run, остановить точный job, поставить
ежедневное или недельное расписание в IANA timezone, приостановить или возобновить
его. Schedule create/update/delete сначала возвращает точный план; применить его
можно только после подтверждения отдельным следующим сообщением. Каждый запуск по
расписанию берёт актуальный `master`, пропускает overlap и учитывает ограниченное
misfire-окно. Project-specific cron/systemd timers намеренно не импортируются по
догадке: перед включением эквивалентного agent-managed расписания оператор должен
отдельно отключить legacy timer, чтобы не получить двойной запуск.

Job одновременно служит минимальным Release без отдельной CI/CD-сущности:
`releaseId` равен job ID, а запись фиксирует полный Git SHA, SHA-256 переданного
source archive и выбранного config, revision зашифрованного env и immutable Docker
image ID. Payload последних 20 завершённых Release сохраняется для проверки и
точного восстановления; metadata и логи — для последних 100. Повтор выполняется
только явным `runner.replay` для точного job ID. Runner заново проверяет hashes
сохранённых payload и наличие immutable image ID; истёкший или повреждённый
Release отклоняется. Команда может повторить внешние production side effects,
поэтому агент вызывает её лишь по прямому указанию owner.

Runner выполняет до `SUMMING_RUNNER_MAX_PARALLEL_JOBS` независимых Project
одновременно (по умолчанию 2). Jobs одного Project сериализуются, поскольку
используют общий writable data volume; заблокированный job не мешает стартовать
следующему независимому Project. `/health` публикует версию SUMMING и runner
protocol, глобальные `running`/`queued` и лимит параллельности; те же данные
доступны агенту через `runner.inspect`. Viewer показывает short release ID и env
revision рядом с каждым job. Live run имеет настраиваемый
`SUMMING_RUNNER_RUN_TIMEOUT_HOURS` (по умолчанию 12 часов, допустимо 1–168),
поэтому многочасовой batch не обрывается прежним четырёхчасовым пределом.

### Jobs и services

Runner намеренно поддерживает два разных lifecycle. **Job** — конечный запуск:
он находится в очереди, получает exit code и ограничен timeout. Расписание создаёт
новый независимый job на каждое occurrence. **Service** — desired state: выбранный
Release должен продолжать работать после завершения deployment-операции и после
рестарта host/rootless Docker. Service не занимает job slot и не наследует
12-часовой `run` timeout.

Именованные services объявляются в immutable source snapshot файла
`.summing/services.json`:

```json
{
  "version": 1,
  "services": {
    "api": {
      "command": ["node", "dist/src/api.js"],
      "containerPort": 3000,
      "healthPath": "/health",
      "startupTimeoutSeconds": 60
    },
    "worker": {
      "command": ["node", "dist/src/worker.js"]
    }
  }
}
```

`command` необязателен и тогда используется `ENTRYPOINT`/`CMD` image. Для API/web
runner закрепляет свободный host port из диапазона
`SUMMING_RUNNER_SERVICE_PORT_START..SUMMING_RUNNER_SERVICE_PORT_END` (по умолчанию
`20000..29999`) и публикует его исключительно на `127.0.0.1`. `service.inspect`
возвращает `localEndpoint`; внешний домен по-прежнему является отдельным явным
маршрутом Caddy и автоматически из Project manifest не создаётся.

`runner.validate` распознаёт service snapshot по `.summing/services.json`, проверяет
все объявления и собранный immutable image и создаёт deployable Release без запуска
legacy entrypoint `node dist/src/main.js --validate`. Runtime-проверка service
выполняется при deployment через его собственную command и health check. Для Project
без service manifest прежняя изолированная validation-команда сохраняется.

`service.deploy` принимает имя и точный ID завершённого non-build Release. Runner
проверяет source/config/environment hashes и immutable image ID, копирует необходимые
runtime snapshots в service storage, запускает контейнер с `restart=unless-stopped`
и ждёт startup/HTTP health check. При неуспешном обновлении новый контейнер удаляется,
а прежний запускается обратно. Текущий и предыдущий deployments сохраняются для
явного `service.rollback`; более старый удаляется после успешного обновления.

`service.restart` перезапускает тот же Release без сборки, `service.stop` меняет
desired state на stopped, `service.start` возвращает уже развёрнутый Release в
running. `service.log` отдаёт ограниченный secret-redacted tail. Все изменяющие
операции выполняются только по явной owner-команде; Viewer разделяет карточки
services и finite jobs, но остаётся диагностическим экраном без кнопок deployment.

Артефакты можно перечислить и безопасно прочитать как недоверенные данные с
лимитом ответа. Удаление одного файла и очистка job/workspace также составляют
точный список целей и требуют подтверждения в следующем сообщении; появившийся
после составления плана файл не удаляется. Подтверждённые allowlist-файлы
перемещаются в закрытую runner-корзину, а не удаляются безвозвратно. Существующий
editor thread без этих инструментов лениво архивируется при первом новом owner
turn: новый thread получает capability, а прежний ID сохраняется для аудита.

Вкладки **Репозиторий** и **Энвы** доступны администратору и любому назначенному
owner только в пределах его Project. Репозиторий
показывает текущую conversation-ветку и её состояние относительно `origin`.
**Push** отправляет только уже существующие commits в одноимённую remote-ветку,
никогда не использует force и не включает dirty working tree. **Pull** сначала
обновляет remote refs и меняет локальную ветку только чистым fast-forward: при
незакоммиченных или разошедшихся изменениях операция останавливается без merge,
rebase или reset. Для private remote заранее настройте non-interactive write
credentials пользователя `summing` либо используйте встроенный SSH-мастер.

Отдельная кнопка публикации в основную ветку доступна тем же owners и
администратору. Viewer определяет её по `origin/HEAD`, затем по опубликованным
`main`/`master` или единственной remote-ветке. Для пустого origin используется
локальная `main`, `master` либо единственная ветка вне служебных пространств
`summing/` и `codex/`. Перед подтверждением Viewer показывает текущий `HEAD`,
целевую ветку и число публикуемых commits. Backend повторно делает fetch, сверяет
полные SHA и разрешает только точный текущий `HEAD` при чистом working tree.
Существующая ветка обновляется только fast-forward; в пустом origin найденная
основная ветка может быть создана обычным push без force. Операция не создаёт
merge commit, не делает reset и не переписывает историю; если remote успел
измениться, требуется обновить состояние и подтвердить публикацию заново.

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
в основную ветку origin, смены URL и ротации записываются в ограниченный журнал с actor,
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

`summing-deploy.timer` каждые 30 минут делает `fetch` закреплённого
`origin/master`. Ту же проверку администратор может немедленно запросить в разделе
**Настройки SUMMING** Mini App **Управление**. Deployment API не требует Project или
Conversation и возвращает `403` любому пользователю, кроме администратора.

`/opt/summing` служит Git-источником deployment и после одноразовой миграции
остаётся detached. Интеграционный `master`, который видит self-project agent,
находится в постоянном linked worktree
`/var/lib/summing/data/repositories/summing/repo`; deploy сначала ждёт завершения
активных runs, затем fast-forward-ит этот worktree либо сохраняет локальные
коммиты, а divergence отклоняет. Conversation worktrees используют тот же Git
common directory, поэтому их ветки и commits переживают restart и смену release.

Release worker не делает `pull`, `reset` или checkout для сборки. Он экспортирует
точный remote commit в `/opt/summing-releases/<sha>`, собирает и
тестирует snapshot от отдельного пользователя `summing-builder`, ждёт завершения
активных Codex runs, атомарно переключает `/opt/summing-current` и проверяет
SUMMING и runner. При неуспешном health check symlink и сервисы автоматически
возвращаются на предыдущий release. Non-fast-forward обновления отклоняются.
После успешного health check worker атомарно синхронизирует из release основные
systemd units, выполняет `daemon-reload` и перезапускает deployment path/timer.
Перед заменой сохраняются временные root-only копии; ошибка reload/restart
восстанавливает прежние units. Release-hook обеспечивает тот же переход при
первом обновлении со старого worker, поэтому новый интервал timer применяется
без ручного SSH.
После успешной установки runtime отправляет администратору Telegram-событие с новой
версией и commit. Ошибка typecheck, сборки или тестов создаёт отдельное fail-событие
с фазой, количеством и именами упавших тестов; хвост build-журнала и секреты в
Telegram не уходят. События лежат в durable outbox deployment-state до успешной
доставки, при этом worker не читает `TELEGRAM_BOT_TOKEN`.

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
