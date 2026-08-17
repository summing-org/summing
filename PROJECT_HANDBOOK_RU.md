# SUMMING 9.8: архитектура, эксплуатация и разработка

> Версия: **9.8.8**
> Целевая среда: один Linux VPS, один администратор, владельцы проектов, один Telegram-бот.
> Последняя сверка с кодом: **17 августа 2026 года**.

Это единый технический документ о проекте. Он описывает продуктовую модель,
архитектуру, состояние на диске, протокол выполнения, авторизацию ChatGPT,
развёртывание через systemd, диагностику и разработку.

Нормативные принципы идентичности и полномочий находятся в
[BIBLE.md](BIBLE.md). Если документация расходится с исполняемым кодом, текущее
поведение определяет код, а расхождение считается дефектом документации.

## 1. Что это за проект

SUMMING — постоянно работающий агент с одним администратором и назначаемыми
владельцами проектов. Они общаются с ним через Telegram, а фактический агентный
цикл выполняет один общий официальный Codex App Server, авторизованный ChatGPT
account администратора.

SUMMING не реализует собственную LLM, набор shell-инструментов или очередной
универсальный agent framework. Его задача:

1. создать Team Space сразу после admission командного источника;
2. долговременно принять доступные сообщения и социальные события до решения
   отвечать или молчать;
3. хранить provenance-ready модель people, sources, evidence и knowledge;
4. отдельно связать topic с Project и локальной рабочей областью;
5. сохранить отдельный контекст каждого диалога;
6. запустить и продолжить Codex thread;
7. передавать новые указания в активный turn или ставить их следом;
8. стримить ответ обратно в Telegram;
9. развести параллельные диалоги по отдельным Git worktree;
10. разделить понимание команды, Project memory и полномочия на действия;
11. дать участникам прозрачное управление собственными данными.

В результате граница ответственности выглядит так:

```text
Telegram и SUMMING                  Codex App Server
---------------------------------  ---------------------------------
администратор/owner/participant     модель и agent loop
binding topic → project             editor/read-only Codex threads
Team Space event journal            one Conversation Understanding Loop
очередь access/steer/follow-up      sandboxed inspection or project work
SQLite-состояние                    sandbox конкретного turn
стрим Telegram                      persistent Codex thread
project memory                      рассуждение и итоговый ответ
systemd/health
```

## 2. Что происходит при запуске

Команда процесса одна:

```bash
npm start
# эквивалентно: node dist/src/index.js
```

В production её запускает systemd. Последовательность старта:

1. читаются переменные окружения и один TOML-конфиг;
2. проверяются обязательные секреты и структура Projects/Workspaces;
3. открывается SQLite в WAL-режиме и загружаются управляемые Projects;
4. создаются каталоги данных, repositories, identity и project memory, если их ещё нет;
5. запускается дочерний процесс `codex app-server`;
6. выполняется JSON-RPC handshake `initialize/initialized`;
7. читается состояние ChatGPT-account;
8. проверяется Telegram token через `getMe`;
9. на loopback-интерфейсе запускается health endpoint;
10. начинается Telegram long polling и обработка событий Codex.

Если конфиг некорректен, `codex` отсутствует, Telegram token неверен или занят
health port, процесс не имитирует успешный запуск: он завершается, а причина
попадает в journal.

При старте runtime также ищет сохранённые `pending_inputs`: direct-очередь
возобновляется сразу, а legacy ambient inputs удаляются, поскольку их authority —
уже записанный Team Space event journal. Pending evidence планируется source-local
Conversation Understanding Loop. Поэтому после рестарта работа может начаться без нового сообщения.
Если очередь пуста, runtime только ждёт Telegram updates и события Codex;
публичный HTTP-сервис не запускается.

## 3. Продуктовая модель

### 3.1. Team Space

Team Space создаётся при первом membership event или сообщении доступного
командного источника. Telegram chat соответствует Space, а каждый topic — Source.
Space хранит людей, provider identities, event journal, производные знания,
interventions и связи с Projects. Подробный контракт находится в
[TEAM_MEMORY_RU.md](TEAM_MEMORY_RU.md).

Admission и Project binding независимы. Непривязанный topic уже является Source
с долговременным evidence journal, но не получает Project/files/tools/network или
agency. `/bind` лишь связывает Project с существующим Space и не стирает ранее
наблюдавшуюся историю.

### 3.2. Project

Project объединяет несколько диалогов, одну долговременную память и одну или
несколько локальных рабочих областей.

Пример:

```text
Project: Secret Cloud
├── Owner: Telegram user 123456789
├── Workspace: web-app
├── Workspace: backend
├── Conversation: Telegram topic «Auth»
├── Conversation: Telegram topic «CI/CD»
└── Conversation: Telegram topic «Frontend»
```

Есть два источника Projects:

- статические Projects из TOML принадлежат администратору;
- управляемые Projects администратор создаёт в личном Telegram-чате через
  `/project_create` или `/project_clone`; они хранятся в SQLite, получают одного
  обязательного primary owner для уведомлений и могут иметь несколько
  совладельцев с одинаковыми рабочими правами.

Администратор имеет рабочий доступ ко всем Projects. Любой назначенный Project
owner видит, привязывает и изменяет только свои Projects. Primary owner не имеет
дополнительных write-прав: его особая роль — быть единственным адресатом
автоматических уведомлений Project. Остальные участники уже
привязанного group topic могут задавать вопросы о текущем Project, но не получают
команд или write-доступа. Перезапуск после создания не нужен.

### 3.3. Workspace

Workspace — именованный абсолютный путь к локальному каталогу:

```toml
[projects.secret-cloud.workspaces.web-app]
path = "/srv/projects/secret-cloud/web-app"
```

Каталог может быть:

- корнем Git-репозитория;
- подкаталогом monorepo;
- обычным каталогом без Git.

Для TOML-проектов каталог заранее готовит администратор. Для управляемых проектов
SUMMING сам создаёт или клонирует Git-репозиторий в
`$SUMMING_DATA_DIR/repositories/<project-id>/<repo-id>`. Он настраивает локальную
Git identity `SUMMING <summing@localhost>` и гарантирует существование начального
commit, чтобы conversation worktree можно было создать даже для нового или
пустого remote.

SUMMING не содержит GitHub App или PR/release pipeline. Обычные remotes,
credentials и правила push принадлежат локальному Git/Codex. Token нельзя
встраивать в Git URL: для приватного remote следует настроить SSH или credential
helper пользователя systemd `summing`.

### 3.4. Conversation

Conversation — один Telegram topic:

```text
telegram chat_id + message_thread_id
                ↓
         conversation_id
                ↓
       project_id/workspace_id
                ↓
      Git worktree
       ├── editor Codex thread
       └── read-only Q&A Codex thread
```

Telegram topic не равен Project. Несколько topics могут быть привязаны к одному
Project и даже к одному Workspace. История у них разная, память Project общая.
Перепривязать уже занятый topic может только владелец текущего Project или
администратор.

Внутри привязанного group topic есть два независимых контекста. Администратор и
назначенный Project owner работают в editor thread. Любой другой Telegram user,
от которого Bot API получил сообщение в этом topic, работает в общем для topic
read-only Q&A thread. Он может спрашивать об исходниках и реализации, но все его
slash-команды блокируются до Codex. Read-only thread не видит editor history,
runtime identity/project memory, `.env` и файлы ключей.

Чтобы runtime получал каждое обычное сообщение, бот должен быть администратором
forum group либо иметь отключённый Privacy Mode. Во втором варианте используйте
`@BotFather` → `/setprivacy` → `Disable`, затем удалите и заново добавьте бота в
группу: Telegram применяет изменение privacy после повторного добавления. При
стандартном включённом режиме не-администратор видит только адресованные ему
команды и replies, поэтому на полный direct/background routing полагаться нельзя. См.
[официальное описание Privacy Mode](https://core.telegram.org/bots/features#privacy-mode).

В обычном приватном чате `message_thread_id` равен нулю, поэтому весь чат является
одной Conversation. Для нескольких параллельных контекстов предназначена
Telegram forum group.

Непривязанный group topic не является Project Conversation и не создаёт Project
pending input, Run или Telegram-ответ. Однако он является Team Source: каждое
доступное сообщение долговременно попадает в `team_events` до participant rate
limit и до решения об ответе. Event journal переживает рестарт, не ограничен
старым 20-message RAM ring и не очищается при `/bind`.

Явное `@mention` или reply на сообщение бота в непривязанном топике создаёт свежий
projectless read-only Codex thread с `ephemeral = true` и `environments = []`; после
ответа runtime вызывает `thread/unsubscribe`. В prompt попадают прямой вопрос,
последние 20 видимых evidence events этого Source и текст ответа бота при reply
на него. Это explicitly requested Q&A boundary, а не автоматический background
understanding. Одно лишь `@mention` без вопроса обрабатывается локально подсказкой,
но само сообщение остаётся evidence. CWD — отдельный
пустой runtime-каталог; доступ к Project/Workspace,
project memory, editor/read-only thread привязанных топиков, сети и внешним интеграциям
отсутствует. Встроенный shell остаётся доступен только для read-only
inspection отдельного пустого CWD и не открывает Project. Вложения не скачиваются.
Credential-подобный текст перехватывается до Team Space journal, удаляется и
аудитируется; при успешном удалении предупреждение
отправляется только на явное обращение, а при ошибке удаления — всегда, чтобы участник
удалил credential вручную. Такой ответ rate-limited для обычных участников, имеет
отдельный single-worker queue с общим потолком в четыре активных/ожидающих вопроса и
двухминутный timeout с `turn/interrupt`. Он не превращает топик в binding;
последующая фоновая беседа остаётся тихой, но продолжает пополнять локальный
evidence journal.

Runtime запрашивает Telegram updates типов `message`, `edited_message`,
`channel_post`, `edited_channel_post`, `message_reaction`,
`message_reaction_count`, `my_chat_member` и `chat_member`. Из
`my_chat_member` он сохраняет chat metadata, текущий статус бота, добавившего
пользователя, время присоединения и последний исходный membership event, а также
создаёт Team Space и публикует прозрачное admission notice. Telegram
не передаёт в этом событии список уже существующих forum topics, поэтому
`topic_id` и доступное название регистрируются по первому увиденному сообщению,
`forum_topic_created` или `forum_topic_edited`. Администратор просматривает реестр
командой `/topics` и привязывает обнаруженный топик командой `/bind_topic` в
личном чате с ботом. Существующие bindings автоматически попадают в реестр при
миграции SQLite, хотя название старого чата или топика может оставаться неизвестным
до следующего Telegram update. Edit и erasure переводят зависимые knowledge
items в `needs-review`; provider redelivery идемпотентна.

Автоматический Conversation Understanding Loop не выводится из факта
локального хранения. Он требует отдельного operator consent на model egress,
описанного в `TEAM_MEMORY_RU.md`, и настройки
`team_memory.model_egress_enabled = true`. До первого batch runtime публикует
отдельный egress notice. Без consent pending evidence остаётся локальным и не
передаётся фоновым Codex turns.

При включении runtime собирает source-local bounded batch по quiet window, hard deadline
или event cap, создаёт fresh ephemeral read-only Codex thread в пустом runtime CWD с
выключенными network, environments и внешними capabilities и требует единый structured
output для episode, knowledge и intervention. Runtime повторно валидирует evidence ids,
confidence, visibility, temporal validity, supersession и reply target до SQLite. Ошибка
оставляет events pending.
Для настоящего reply evidence batch содержит не только provider message id, но и
`reply_target` snapshot исходного event: автора, время и текст последней доступной
версии. Техническая ссылка Telegram forum message на корневое service-message topic
не является reply и удаляется как из нового ingest, так и из накопленных legacy events;
зависимые understanding results переводятся в `needs-review`, а evidence переосмысливается.
После `team_memory.orientation_event_threshold` SUMMING один раз объясняет текущее понимание и
задаёт главные вопросы; последующие evidence-linked proactive replies имеют cooldown.

### 3.5. Run

Run — один явно запрошенный пользовательский turn внутри Project Conversation. Каждый
Run имеет `access_mode`: `write` для администратора/owner или `read-only` для участника,
а его persisted `response_mode` равен `direct`. Background understanding не является
Project Run и использует отдельный ephemeral thread без Project.

Инварианты:

- у Conversation одновременно не более одного активного Run;
- разные Conversations могут работать параллельно;
- Runs одного non-Git Workspace выполняются последовательно, чтобы read-only
  снимок запрещённых путей не гонялся с editor-записью;
- глобальный предел задаёт `max_parallel_conversations`;
- Run не является отдельным долго живущим task-объектом;
- история Run хранится для диагностики, а смысловой контекст хранит Codex thread.

## 4. Маршрутизация сообщений

Новые `pending_inputs` всегда являются direct и различаются полномочием `access_mode`
(`write` или `read-only`). Editor inputs никогда не объединяются с participant inputs.
Значение `response_mode=ambient` сохраняется в SQLite только для совместимости со
старыми базами; при старте такие inputs удаляются в пользу уже durable `team_events`.

Полномочие автора не превращает каждую его реплику в команду. В group/supergroup
сообщение администратора или Project owner с ведущим `@mention` другого пользователя
либо reply на сообщение человека классифицируется как background evidence и вообще не
создаёт Project input. Явное упоминание бота, reply боту и slash-команда имеют
приоритет и остаются direct. Поэтому человеческая беседа не запускает и не steer-ит
editor/read-only turn, но остаётся Team Space evidence и входит в общий understanding batch.

Telegram Bot API добавляет `reply_to_message`, равный `message_thread_id`, к обычным
сообщениям forum topic. Это transport edge на корневое service-message, а не действие
пользователя: runtime исключает его до определения direct/ambient. Настоящий reply
сохраняется внутри durable input как host-сформированный контекст с message id, sender
identity и bounded безопасной цепочкой: ближайшая цитата дополняется сохранённым
текстом того же event из локального evidence journal, поэтому уже готовая транскрипция
аудио используется повторно без повторного скачивания и распознавания. Её предки
разрешаются по `reply_to_external_event_id` того же Source из локального
evidence journal, максимум до восьми уровней. Цикл, отсутствующий или redacted event
останавливает обход; каждый текст повторно проходит credential-фильтр. Поэтому голый
`@username_бота` в reply означает «проследи ссылки вроде “вот” и отреагируй на самый
глубокий содержательный контекст», а не общий ping. Если пользователь добавил mention бота через
Telegram edit, изменённое сообщение журналируется как edit и повторно проходит direct
routing; обычные исправления без явного обращения нового Run не создают.

### 4.1. Прямое обращение участника

Упоминание `@username_бота` или reply на сообщение самого бота получает
`response_mode=direct` и запускается без background batch-delay. Это явный запрос на ответ, но всё ещё в отдельном
read-only thread: запускать команды или изменять Project от этого нельзя.

Для непривязанного топика те же признаки direct (`@mention` или reply боту) не
попадают в Project routing: они запускают отдельный fresh projectless Q&A, описанный
в разделе 3. Обычное сообщение там пополняет долговечный локальный Team Space journal.
При явном consent оно входит в тот же Conversation Understanding Loop, что и bound
source; loop не является Project routing и не получает Project context или agency.

### 4.2. Один Conversation Understanding Loop

Остальные сообщения не становятся `pending_inputs` Project Conversation. Durable
ingest сначала фиксирует их в `team_events`, затем один source-local scheduler собирает
Conversation Episode. Это единственный фоновый model loop: старого Project ambient
turn и отдельного Team Space synthesis turn больше нет.

Окно адаптивно. Новое событие перезапускает trailing quiet timer
`team_memory.understanding_quiet_sec` (20 секунд), но время от первого pending event
ограничено `understanding_max_wait_sec` (90 секунд). При
`understanding_max_events` (40) loop стартует немедленно. Поэтому короткий burst даёт
один вызов после паузы, а непрерывная беседа не зависает и не смешивается с другим
Telegram topic. Background processors глобально сериализованы; события продолжают
durable ingest, пока другой Source ждёт model capacity.

В один ephemeral read-only Codex turn передаются текущий Team Space summary, до 50
knowledge items и provider-neutral evidence одного Source: sender/person identity,
event/message/reply ids, timestamps, текст, attachment metadata, транскрипции и bounded
snapshot реального reply target. Project files, Project memory, editor history, network,
tools и environments недоступны.

`turn/start.outputSchema` требует один согласованный объект:

1. `episode`: source, тема, synopsis, полный набор batch event ids, confidence и
   роли участников (`speaker`, `addressee`, `mentioned`) с evidence-linked intent;
2. новый Team Space summary;
3. knowledge candidates и их provenance;
4. orientation readiness и уточняющие вопросы;
5. `intervention`: `silent` либо `reply`, target event, сообщение и внутренняя причина.

Runtime автоматически сохраняет episode как source-visible knowledge. Перед commit он
повторно валидирует Source/Space/person boundaries, полноту episode, evidence ids,
confidence, temporal validity, visibility, supersession и Telegram reply target. Любая
ошибка оставляет batch pending и включает exponential backoff; частичное понимание не
публикуется.

Молчание — default для человеческой беседы и успешный результат loop. Оно обновляет
episode и память, но не создаёт Telegram message. `reply` допустим только при
существенной неоднозначности, фактической ошибке, противоречии, blocker, риске или
незакрытом решении. До orientation threshold возможна только одна orientation; затем
видимые вмешательства ограничены Space cooldown и всегда отвечают конкретному event.

Loop не запускает второй Project-aware анализ. Если проверка требует repository/files,
она остаётся явно сформулированным пробелом; mention/reply боту создаёт отдельный direct
turn с полномочиями отправителя. Таким образом прямой ответ может быть дополнительным
model call, но второго фонового прочтения той же реплики нет.

Sliding-window rate limit 12 сообщений за 60 секунд применяется к явно адресованным
direct Q&A обычного участника. Background evidence принимается до rate limit и не
теряется из памяти; оно ограничено source batching, max events и общей model capacity.
Администратор и Project owner direct-лимитом не ограничены.

### 4.3. Steer

Steer меняет уже выполняющийся turn. Он создаётся:

- командой `/steer <текст>`;
- reply на одно из стриминговых сообщений текущего ответа.

SUMMING вызывает официальный `turn/steer` с `expectedTurnId`. После успешной
доставки запись помечается обработанной. Если steering отклонён или turn уже
закрылся, сообщение не теряется: оно остаётся и становится частью следующего
turn.

### 4.4. Follow-up владельца

Обычное сообщение во время Run не создаёт параллельную задачу в том же topic. Оно
попадает в `pending_inputs` как follow-up.

После завершения активного Run SUMMING:

1. забирает оставшиеся steer и все follow-up;
2. сохраняет их порядок;
3. объединяет их в один следующий prompt;
4. запускает следующий turn в том же Codex thread.

Сообщение ставится в очередь без отдельного служебного ответа, чтобы не засорять
topic.

### 4.5. Стриминг

В начале direct Run бот не отправляет служебное сообщение, а включает нативное
Telegram-событие `sendChatAction` с действием `typing` в том же topic. Пока turn выполняется,
runtime обновляет этот индикатор каждые четыре секунды: Telegram показывает
анимацию «печатает…», но отдельные сообщения в чат не добавляются. Ошибка
обновления индикатора только записывается в лог и не прерывает Run; перед
финальным ответом или при аварийном завершении heartbeat останавливается. Первое
Telegram-сообщение содержит уже сам ответ и сохраняет reply на исходный запрос. Дельты
`item/agentMessage/delta` накапливаются и не чаще заданного интервала заменяют
текст этого сообщения через `editMessageText`.

Runtime отдельно накапливает авторитетные завершённые `agentMessage` с фазой
`commentary`. Когда приходит `final_answer`, предыдущие commentary вставляются
перед ним как нативная свёрнутая `<blockquote expandable>` с заголовком
**«Ход работы · N мин N сек»**. В журнал не входят reasoning items, tool arguments,
stdout/stderr или file diffs; сохраняется только уже показанный пользователю текст
агента. Журнал ограничен последними 12 000 Unicode-символами и при усечении явно
помечает скрытые ранние обновления. Если вместе с Run пришло аудио, «Ход работы» и
транскрипция остаются двумя независимыми свёрнутыми блоками. Если финальный рендер
короче промежуточного многочастного stream, ставшие лишними Telegram-сообщения
удаляются.

Перед каждым `sendMessage`/`editMessageText` Markdown агента преобразуется в
экранированный Telegram HTML. Рендерер поддерживает заголовки, списки и task-list,
bold/italic/strikethrough/spoiler, ссылки только с разрешёнными схемами, blockquote,
inline code, fenced code blocks и GitHub-style таблицы; сырой HTML модели остаётся
текстом. Если ответ длиннее безопасного лимита Telegram, создаются дополнительные
самостоятельно сбалансированные HTML-сообщения: форматирующие теги и entities не
разрезаются. Reply на любую часть активного потока распознаётся как steer. На
завершении выполняется принудительный flush итогового текста. Conversation
Understanding turn не использует Telegram stream, но его прошедшая gates интервенция
проходит тот же Markdown → Telegram HTML boundary.

### 4.6. Telegram polling и offset

Bot API опрашивается через `getUpdates` с long-poll timeout 50 секунд; runtime
запрашивает только updates типа `message`. HTTP-запрос имеет timeout 70 секунд и
до четырёх попыток. Для ответа 429 учитывается `retry_after`, ограниченный 30
секундами; остальные transport errors получают линейный backoff.

Updates обрабатываются последовательно. После каждой попытки обработки — в том
числе если handler вернул ошибку и бот смог сообщить её владельцу — следующий
offset сохраняется в SQLite. Поэтому такая ошибка не приводит к автоматическому
повтору того же Telegram update.

### 4.7. Документы, архивы и аудио

Сообщение может содержать `document`, `voice` или `audio`. Runtime сначала
проверяет binding, ACL и participant rate limit, затем вызывает Telegram
`getFile` и скачивает не более 20 МБ в приватный
`$SUMMING_DATA_DIR/attachments/<conversation-id>/`. Имя очищается от path
components и управляющих символов; pending input хранит типизированные metadata,
поэтому вложение переживает рестарт до начала Run.

Документ перед Run копируется в
`.summing-runtime/attachments/<message-id>-<input-id>-<name>`. Каталог исключён
из Git и доступен Codex только на чтение, в том числе в guest profile. ZIP не
распаковывается host-процессом: это исключает zip-slip и decompression bomb на
privileged boundary. Editor может распаковать проверенный архив только в
`.summing-runtime/tmp`; read-only thread ограничивается `unzip -l`/`unzip -p` и
другими не меняющими состояние inspection-командами.

Voice, Telegram audio и аудиодокумент поддерживаемого формата отправляются по
multipart HTTPS выбранному transcription provider. По умолчанию это OpenAI
endpoint `/v1/audio/transcriptions` и точная модель `gpt-transcribe`; опционально
можно выбрать Groq endpoint `/openai/v1/audio/transcriptions` и
`whisper-large-v3-turbo`/`whisper-large-v3`. Ключ берётся только из
`OPENAI_API_KEY` либо `GROQ_API_KEY` host-процесса и не попадает в Codex App
Server или shell. В очередь передаётся полученный transcript, а локальный
аудиофайл сразу удаляется. Отдельные безопасные metadata транскрипции переживают
ожидание и рестарт очереди: перед ответом Telegram показывает распознанный текст
нативной свёрнутой expandable-цитатой и сохраняет её во всех streaming edits.
Текст экранируется на HTML boundary; несколько voice inputs в одном batch
разделяются исходными именами. При отсутствующем ключе пользователь получает
явную инструкцию по настройке.

Для обратного направления editor-run кладёт каждый готовый пользователю файл
непосредственно в `.summing-runtime/outbox/`. Каталог очищается перед Run и
доступен на запись только write-профилю; read-only participant не может создавать
исходящие документы. После успешного `turn/completed` runtime принимает не более
10 обычных файлов с `nlink === 1`, открывает их с `O_NOFOLLOW`, ограничивает их
совокупный размер `transcription.max_file_bytes` и отправляет multipart-методом
Telegram `sendDocument` как reply к исходному запросу. Каталоги, symlink,
oversized payload и лишние файлы не отправляются, а пользователь получает
отдельное предупреждение. Локальный путь VPS никогда не публикуется как ссылка.

## 5. Параллельность и Git worktree

Несколько topics одного репозитория могут одновременно менять файлы. Использовать
один checkout для этого небезопасно, поэтому Git-Workspace получает постоянный
worktree на Conversation:

```text
$SUMMING_WORKTREE_ROOT/
└── tg-<hash>/
    ├── .git
    ├── файлы репозитория
    └── .summing-runtime/
```

Ветка имеет вид:

```text
summing/<project-id>/<conversation-id>
```

При первом обращении ветка создаётся от текущего `HEAD` исходного checkout. При
следующих обращениях используется тот же worktree и та же ветка. Если каталог
worktree был удалён, но ветка сохранилась, она подключается без reset.

Перед повторным использованием существующего worktree SUMMING сравнивает его
общий Git directory с исходным репозиторием. Если topic перепривязали к Workspace
из другого репозитория, но старый каталог `tg-<hash>` остался на диске, Run
завершится ошибкой до ручной очистки или переноса старого worktree. Runtime сам
не удаляет такой каталог.

Существующий worktree проверяется по repository identity, но его branch name не
перепроверяется. Поэтому перепривязка Conversation к другому Project в том же
репозитории продолжит использовать прежнюю ветку; для смены ветки оператор
должен явно привести worktree в нужное состояние.

Для Workspace-подкаталога monorepo создаётся worktree всего репозитория, но
рабочим `cwd` Codex становится соответствующий подкаталог.

SUMMING не делает автоматически merge, rebase, commit, push или удаление веток.
Это обычные Git-действия, которые Codex выполняет только в рамках запроса
владельца. Поэтому параллельность изолирует незавершённую работу, но интеграция
веток остаётся явным решением.

Администратор и owner могут синхронизировать текущую conversation-ветку вручную
во вкладке **Репозиторий** Project Viewer. Это не автоматическая интеграция:
каждый Push, Pull или fast-forward текущего `HEAD` в `origin/master` запускается
отдельным явным нажатием, а публикация в `master` дополнительно требует
подтверждения пользователя.

Если Workspace не является Git-репозиторием, используется исходный каталог
напрямую. Runs одного такого Workspace сериализуются: это сохраняет целостность
read-only профиля, но не даёт изоляции незавершённых изменений между
Conversations. Для параллельной разработки рекомендуется Git. Автоматическое добавление
`.summing-runtime/` в Git `info/exclude` выполняется только для Git worktree.

## 6. Контекст и память

В SUMMING осталось четыре уровня состояния.

### 6.1. Identity

```text
$SUMMING_DATA_DIR/memory/identity.md
```

Файл создаётся один раз и не перезаписывается при старте. Он описывает устойчивую
идентичность агента. Доступ рекомендуется ограничить владельцем процесса.

### 6.2. Project memory

```text
$SUMMING_DATA_DIR/projects/<project-id>/memory.md
```

Это общая долговременная память всех Conversations проекта. Перед turn её снимок
попадает в `.summing-runtime/memory/PROJECT_MEMORY.md`.

Контекст просит агента только добавлять устойчивые факты. После Run SUMMING
сравнивает локальный файл со снимком, сделанным перед Run:

- append-only суффикс добавляется к текущему авторитетному файлу, если его там ещё
  нет;
- полная версия принимается, если авторитетный файл с момента снимка не менялся;
- если Conversation переписала память и одновременно изменилась authority,
  обе версии сохраняются в `memory-conflicts/`, а путь к конфликту отправляется
  в Telegram.

`/remember <факт>` добавляет факт напрямую в Project memory.

### 6.3. Conversation history

Историю диалога хранит persistent Codex thread. Его id находится в SQLite. Команда
`/new` отвязывает thread и начинает новый контекст, не удаляя Project memory и
Git worktree.

### 6.4. Run scratch

В рабочей области создаются:

```text
.summing-runtime/
├── CONTEXT.md
├── memory/
│   └── PROJECT_MEMORY.md
├── attachments/
├── outbox/
└── tmp/
```

Они исключаются через Git info/exclude и не должны попадать в commit. Это
производный контекст конкретного запуска, а не второй источник истины. Для
non-Git Workspace исключение отсутствует.

## 7. Codex App Server и ChatGPT subscription

SUMMING использует один execution substrate: официальный `codex app-server`.
Связь с ним идёт по JSON Lines/JSON-RPC через stdin/stdout дочернего процесса.

Используемая поверхность:

| Метод/событие | Назначение |
|---|---|
| `initialize` | Согласовать клиент и сервер. |
| `account/read` | Проверить авторизацию и plan. |
| `account/login/start` | Начать ChatGPT device-code login. |
| `account/rateLimits/read` | Получить quota windows VPS-аккаунта. |
| `thread/start` | Создать постоянный контекст Conversation. |
| `thread/resume` | Возобновить сохранённый thread. |
| `turn/start` | Запустить direct Run или один ephemeral Conversation Understanding turn со structured `outputSchema`. |
| `turn/steer` | Передать указание в активный turn. |
| `turn/interrupt` | Реализовать `/cancel`. |
| `item/agentMessage/delta` | Стримить ответ. |
| `item/completed` | По `agentMessage.phase` отдельно зафиксировать `commentary` для свёрнутого журнала и `final_answer` как итоговый ответ. |
| `error` | Сохранить ошибку активного Run. |
| `turn/completed` | Закрыть Run и сохранить результат. |
| `account/updated`, `account/login/completed` | Обновить локальный account status. |
| `account/rateLimits/updated` | Немедленно перечитать snapshot лимитов. |

ChatGPT OAuth-токены хранит и обновляет сам Codex в выделенном
`$CODEX_HOME`. API key SUMMING не требует.

Перед каждым Run SUMMING создаёт запись `running` и атомарно помечает выбранные
pending inputs как `consumed`, а затем вызывает `account/read`. Если account не
авторизован, Run становится `failed`, но исходный input автоматически в очередь
не возвращается — после входа его нужно отправить повторно. Direct editor Run
просит выполнить `/login`, direct participant Run сообщает о недоступности, а
неудачный understanding batch остаётся pending для retry без сообщения в группу.

Для входа отправьте боту `/login` в **личном чате**. SUMMING не показывает
device code в группе. Команда доступна только администратору. После подтверждения
проверьте `/status`. Все Project owners используют этот общий account и не
выполняют отдельный login.

После авторизации runtime раз в `codex_usage.refresh_interval_sec` и по событию
App Server читает `account/rateLimits/read`. Поле `usedPercent` переводится в
остаток, недельным считается фактически возвращённое окно длительностью не менее
шести суток. `/limits` показывает все окна основного `codex` bucket, а
`setMyShortDescription` публикует недельный остаток, время сброса и текущую
версию SUMMING в профиле Telegram-бота. Это состояние `CODEX_HOME` на VPS;
локальный Codex на ноутбуке в расчёте не участвует. Если недельного окна нет,
runtime явно показывает, что данные недоступны, и не подменяет их коротким
окном.

Официальные источники:

- [Codex App Server](https://developers.openai.com/codex/app-server);
- [Codex CLI](https://developers.openai.com/codex/cli).

## 8. Sandbox и полномочия

Клиент включает experimental App Server API и при `thread/start` или
`thread/resume` выбирает один из двух именованных профилей. Editor thread получает
`summing-project`, в который входят:

- `approvalPolicy = never`;
- `runtimeWorkspaceRoots`, содержащий conversation worktree и только для write-run два
  project-scoped metadata root: общий Git directory и resolved Git directory конкретного
  linked worktree; один и тот же набор передаётся в `thread/start`, `thread/resume` и
  `turn/start`, потому что turn override заменяет сохранённые roots;
- относительная секция `filesystem.:workspace_roots` задаёт только общий read-baseline
  `.`. Write/read/deny для worktree, `.git`, `.summing-runtime`, attachments и secrets
  задаются абсолютными путями: App Server применяет относительное правило к каждому
  runtime root, и worktree-specific правила иначе породили бы ложные mount targets
  вроде `<common-git-dir>/.summing-runtime`;
- `filesystem.:minimal = read` для необходимых системных путей;
- каталог, содержащий реальный executable `CODEX_BIN` после разрешения symlink,
  доступен только на чтение: standalone Codex повторно запускает этот binary
  внутри Linux sandbox при выполнении shell-команд;
- versioned root установленного Node.js вычисляется из реального `process.execPath` и
  доступен editor-профилю только на чтение. Поэтому `/usr/local/bin/node`, `npm`, `npx`
  и `corepack` продолжают работать, даже когда это symlink на `/opt/node-v*/`, а один
  `PATH` сам по себе не раскрывает target внутри sandbox;
- read всего текущего worktree и write только текущего Workspace внутри него;
- служебный `.summing-runtime` доступен на чтение, а запись разрешена только в
  каталогах `memory/` и `tmp/`; `attachments/` доступен только на чтение;
  permission profile не использует отдельный файл
  `PROJECT_MEMORY.md` как writable root;
- `.git`-указатель worktree доступен на чтение, а project-scoped общий Git directory и
  resolved `.../.git/worktrees/<id>` получают отдельные exact write-grants. Это сохраняет
  защиту Git metadata других worktree, но позволяет owner выполнять `git add`, commit,
  rebase и push: более широкий grant только на common dir не снимает рекурсивную защиту
  resolved linked-worktree directory;
- временные файлы editor создаются в `.summing-runtime/tmp` текущего worktree,
  а не в общем системном `/tmp`;
- network выключен или, при `agent.network_access = true`, явно разрешены все
  домены;
- `shell_environment_policy.inherit = none`: shell получает только безопасные
  `PATH` и `LANG`, но не Telegram token и прочие service secrets;
- каждый project root помечен для Codex как `untrusted`, поэтому project-local
  `.codex/config.toml`, hooks и rules не загружаются;
- Apps, Browser/Computer Use, Image Generation, hooks, memories, plugins,
  multi-agent и skill discovery выключены;
- системный `/etc/codex/requirements.toml` содержит пустые managed allowlists
  MCP/plugin servers, поэтому user/project config не может вернуть интеграции
  общего account администратора.

Read-only Q&A thread получает `summing-project-readonly`: Workspace доступен
только на чтение, network, web search, Browser и Computer Use выключены, а
`.summing-runtime` (кроме read-only `attachments/`), `.env`, `.envrc`, `.ssh`, Git/package/cloud credentials,
private keys, certificates и symlinks перед каждым guest run рекурсивно
обнаруживаются host-процессом и закрываются точными deny-путями без ограничения
глубины. Его prompt дополнительно
запрещает builds, tests, servers, package managers, scripts и любые команды с
побочными эффектами. Этот prompt управляет поведением, а именованный permission
profile и `approvalPolicy = never` являются технической границей, которая не даёт
записать изменения или запросить расширение прав.

`turn/start` повторяет `runtimeWorkspaceRoots` и наследует профиль thread. Поля
legacy `sandbox`/`sandboxPolicy` вместе с именованным профилем не передаются.

У SUMMING нет Telegram-интерфейса подтверждений. Если управляемая политика всё же
присылает command/file approval request, клиент отвечает `decline`; permission
request получает пустой набор permissions, а legacy approvals — явный отказ.
Любой другой server-initiated request получает ошибку `-32601`.

App Server запускается с минимальным allowlist переменных окружения, а shell
получает отдельную ещё более узкую политику. Форма именованного permission profile
сверена с официальной документацией Codex App Server и реальным установленным
сервером.

`CODEX_HOME` должен быть выделен только SUMMING и использоваться для auth/state.
Runtime откажется запускаться, если его `config.toml` содержит MCP servers или
hooks. `deploy/activate.sh` при каждом развёртывании обновляет системные Codex
requirements из [deploy/codex-requirements.toml](deploy/codex-requirements.toml).

Дополнительные границы:

- `TELEGRAM_OWNER_ID` идентифицирует администратора;
- вне привязанного group topic команды принимаются только от администратора или
  owner существующего Project; обычные сообщения наблюдаются без Run и ответа,
  а явный mention/reply доступен участникам только как projectless read-only Q&A;
- owner может увидеть, привязать и выполнять команды только в своём Project;
- остальные участники привязанного group topic могут отправлять только обычные
  Q&A-сообщения; все slash-команды блокируются;
- direct mention/reply получает приоритетный read-only ответ, остальные сообщения
  входят в один source-local Conversation Understanding batch и могут не породить ответ;
- Q&A использует отдельный persistent thread и именованный профиль с read-only
  project root, выключенными network/web search/extensions и denied secrets;
- создание/клонирование Projects, `/login`, `/restart` и `/panic` доступны только
  администратору;
- управляемые пути строятся самим runtime, а не принимаются из Telegram;
- health API слушает loopback;
- OAuth state, Telegram token и SQLite защищаются Unix-permissions/UMask;
- публичная публикация сервисов не входит в runtime;
- неожиданные протокольные состояния завершаются ошибкой.

Участник group topic получает возможность узнавать содержимое Project через
ответы бота. Поэтому Telegram membership/ACL определяет круг читателей, и
администратор должен добавлять в forum group только тех, кому разрешено видеть
реализацию Project. Read-only sandbox запрещает изменения и внешние действия, но
не является механизмом сокрытия исходного кода от участников topic.

## 9. Самоизменение

В конфиге собственный репозиторий можно отметить:

```toml
[projects.summing]
self_change = true
```

Флаг лишь сообщает контексту, что Workspace является телом SUMMING. Отдельного
механизма автоматического самоизменения он не включает. Изменять код разрешено
только по прямой команде администратора.

`self_change` не является единственным authorization gate. Статический проект
SUMMING принадлежит администратору, а значение флага попадает в
`.summing-runtime/CONTEXT.md`; прямой запрос администратора дополнительно
обеспечивается конституцией и инструкцией модели.

Ожидаемый процесс:

1. администратор формулирует изменение в привязанном topic;
2. Codex работает в отдельном conversation worktree;
3. запускает профильные тесты;
4. показывает проверяемый итог и diff;
5. по запросу выполняется `/review` в том же Conversation;
6. commit/merge/push выполняются как обычные Git-операции.

`/review` добавляет обычный follow-up prompt с инструкцией не менять файлы. Он
использует тот же persistent Codex thread и тот же именованный permission profile,
поэтому это не независимый reviewer и не технически read-only режим.

### 9.1. Project Viewer и изолированный runner

Project Viewer — второй loopback HTTP server (`127.0.0.1:8766`). Статический
mobile-first интерфейс и JSON API показывают:

- tracked/untracked дерево без `.git`, `.summing-runtime`, secrets, dependency,
  build и persistent-data каталогов;
- только regular text files до 1 МБ без symlink traversal;
- working diff относительно `HEAD`, включая синтетический diff untracked files;
- последние commits и diff commit относительно parent;
- before/after patch конкретного editor Run;
- подключение отсутствующего `origin` через проектный SSH deploy key, состояние
  текущей ветки относительно remote, явные Pull/Push и отдельную fast-forward
  публикацию текущего `HEAD` в `origin/master`;
- очередь, статусы и журналы project runner.

Тот же server публикует отдельный администраторский Mini App на `/admin`, которому
не нужна заранее созданная Conversation. Он показывает каталог статических и
управляемых Project, обнаруженные Telegram supergroup/topics, их текущее binding и
busy-состояние, а также число наблюдаемых пользователей в каждой группе и topic.
По клику отдельный exact-admin API лениво возвращает карточки авторов: Telegram ID,
актуальные доступные имя/username/language/bot/premium metadata, число сообщений,
число затронутых topics и первое/последнее наблюдение в выбранном scope. Telegram
Bot API не предоставляет полный список молчащих участников, поэтому эти данные —
сводка авторов доступных боту сообщений, а не membership directory.

Администратор может создать пустой managed Git Project или
клонировать remote, выбрать Project/Workspace для топика и выполнить bind/rebind.
Перепривязка отклоняется, пока у Conversation есть active turn, processor или
pending input; успешная смена использует тот же `StateStore.bind`, сбрасывает оба
Codex thread и worktree path и очищает непостоянный unbound-контекст топика.
Глобальный раздел **Настройки SUMMING** в этом же Mini App показывает deployment
status и запрашивает атомарное обновление без выбора Project или Conversation.
Project Viewer больше не содержит системную вкладку и остаётся scoped-интерфейсом
конкретного Project/Repository.
Карточки пользователей не входят в основной overview payload и загружаются только
при раскрытии группы/topic. `/memory_forget_me` удаляет scoped activity автора из
этой сводки и существующее Team Space opt-out блокирует повторное накопление до
`/memory_resume_me`.

После успешного нового bind/rebind runtime отправляет сообщение именно в связанный
Telegram topic. Primary Project owner упоминается через HTML-ссылку `tg://user?id=<id>`,
поэтому уведомление не зависит от наличия username; доступное наблюдаемое имя
используется только как безопасно экранированная подпись ссылки. Сообщение содержит
Project и Repository и объясняет, что рабочие запросы топика теперь относятся к
этому Project. Неизменившаяся привязка уведомление повторно не создаёт. Ошибка
доставки логируется, но не откатывает уже сохранённый binding.

HTTPS-запрос Mini App должен содержать Telegram `initData`. Backend заново
проверяет HMAC, `auth_date`, Telegram user id и Project owner ACL; данные из
`initDataUnsafe` не являются authority. Локальный bearer token предназначен
только для SSH tunnel. В group topic `/files` выдаёт deep link в личный чат;
там бот создаёт `web_app` button, поскольку Telegram предоставляет Mini App
identity именно в private bot chat.

Git API использует только фиксированный remote `origin` и ветку worktree,
соответствующего открытой Conversation. Перед отображением состояния выполняется
`fetch --prune`; если одноимённой remote-ветки ещё нет, Pull сравнивает текущую
ветку с `origin/HEAD`, затем с `origin/main`, `origin/master` или единственной
доступной remote-веткой. Push отправляет точный показанный `HEAD` в одноимённую
remote-ветку обычным non-force refspec и не включает незакоммиченные файлы. Pull
разрешён только для чистого worktree, когда изменение возможно через
`merge --ff-only`; divergence оставляется пользователю/Codex для явного merge
или rebase.

Отдельный `POST action=push-master` отправляет точный текущий `HEAD` в
`refs/heads/master`. Он требует явный `confirmed=true`, чистый worktree,
существующий `origin/master` и полный ожидаемый SHA как `HEAD`, так и
`origin/master`. После повторного fetch операция разрешена только когда
`origin/master` является предком текущего `HEAD`; обычный non-force push
дополнительно закрывает race между fetch и публикацией. Mini App не создаёт
основную ветку, merge commit, reset/rebase и никогда не переписывает историю.

POST содержит ожидаемый полный HEAD, поэтому устаревшая кнопка не публикует и не
обновляет уже изменившуюся ветку. Viewer-операции сериализуются на общий Git
directory репозитория, включая все его conversation worktrees, и
не запускаются во время активного Codex turn. Telegram HMAC и Project ACL дают
write-кнопки только администратору и любому назначенному owner. Тот же ACL открывает
вкладку **Энвы**: администратор управляет всеми Project, а каждый owner может читать и
сохранять plaintext environment только своего Project; участник или owner
другого Project получает `403`. POST `action=connect`
принимает только нормализованный SSH URL, добавляет только отсутствующий
`origin` и никогда не заменяет существующий remote. Для уже настроенного SSH
remote тот же action без URL создаёт ключ, не меняя Git config. Ошибка auth,
network, protected branch, dirty worktree или
non-fast-forward возвращается в UI без force, reset или автоматического commit.
Remote subprocess получает только минимальные `HOME`/`PATH`/locale/SSH env без
application secrets, игнорирует repository hooks и fsmonitor и принимает только
SSH/HTTPS URL без embedded token. Project-local/worktree `include`, URL rewrite,
credential helper, `core.sshCommand` и executable filter отключают sync, чтобы
изменяемая Codex Git metadata не превращалась в исполнение команд host-сервисом.
Встроенный мастер создаёт отдельный Ed25519 key pair для пары
Project/workspace в
`$SUMMING_DATA_DIR/repository-credentials/<project>/<workspace>/`: каталог и
`known_hosts` имеют режим `0700`/`0600`, private key — `0600`. API возвращает
только public key и SHA-256 fingerprint; private path, private key и SSH command
не сериализуются. Managed SSH запускается через `/usr/bin/ssh` с отключёнными
user config/agent/password prompts, единственным project key и отдельным
`known_hosts`. Первый host key закрепляется по TOFU (`accept-new`), а его
последующая подмена отклоняется. Файлы лежат вне repository, worktree, Codex
archive и окружения runner/Codex. Потеря private key требует выпустить новый
deploy key на стороне Git-сервиса.

Если managed key отсутствует, сохраняется прежний внешний режим: доверенный SSH
config или credential helper настраивается глобально для Unix user `summing`, а
не внутри Project repository. HTTPS остаётся допустимым только в этом режиме и
без embedded token; встроенный мастер намеренно принимает лишь SSH URL.

Production Mini App работает на `https://assist.summing.org`. Installer
принимает `SUMMING_VIEWER_DOMAIN=assist.summing.org` и необязательный
`SUMMING_VIEWER_REDIRECT_DOMAIN=ash.summing.org`: Caddy сначала валидирует
временный конфиг, затем атомарно устанавливает основной reverse proxy и
постоянный redirect старого адреса с сохранением URI. Runtime получает основной
URL через `SUMMING_VIEWER_URL`. Runtime устанавливает для личного чата точного
`TELEGRAM_OWNER_ID` постоянную кнопку меню **Управление**, ведущую на `/admin`;
первый `/start` также обновляет menu button и возвращает inline `web_app` button.
В карточке управляемого Project администратор добавляет и удаляет owners и
назначает любого из них primary. Primary нельзя удалить, пока другой owner не
назначен primary; backend атомарно сохраняет обязательный primary вместе с полным
списком owners. Для config-проектов этот блок read-only.
Project owner по-прежнему открывает конкретный viewer через `/files`, поэтому не
получает администраторскую точку входа или список чужих проектов.

До editor Codex turn host создаёт временный Git commit через отдельный index,
не меняя branch или настоящий index worktree. После turn создаётся второй
snapshot и сохраняется patch в `run-artifacts`. Snapshot включает tracked и
untracked, но соблюдает `.gitignore`.

Runner работает отдельным Unix user `summing-runner` и использует собственный
rootless Docker daemon. Пользователь `summing` не получает Docker socket. Через
Unix socket принимаются только project id, одна из четырёх фиксированных
операций и Git archive до 50 МБ. Runner не читает conversation worktree: SUMMING
сам создаёт immutable archive выбранной ревизии и передаёт его в запросе.
Application config выбирается из того же распакованного archive по root-managed
списку `configSourcePaths` и монтируется в контейнер read-only. Для `ash-seo`
сначала используется `config.json`, а для старых pinned revisions допускается
`config.example.json`; постоянная копия `/etc/summing-runner/projects/ash-seo.config.json`
не является runtime source. Поэтому code SHA, config и env revision образуют один
проверяемый job snapshot, а изменение Project config не требует ручной синхронизации
дублирующего host-файла. Старый абсолютный `configPath` сохранён только как
совместимый режим для других root-managed Project.
Контейнер запускается read-only, без capabilities, с `no-new-privileges`, PID,
CPU и memory limits; writable остаётся только project data bind mount.

`validate`, `dry-run` и `build` могут использовать временный snapshot грязного
worktree. `run` требует чистый committed `HEAD`. Периодический запуск читает
`/etc/summing-runner/schedules/<project>.json`, поэтому всегда закреплён на
явном полном SHA и не меняется от последующих commits самопроизвольно.

## 10. Telegram-команды

| Команда | Поведение |
|---|---|
| `/start`, `/help` | `/start` в личном чате администратора открывает центр управления и устанавливает menu button; `/help` сохраняет подробную резервную справку. |
| `/admin` | Повторно показать кнопку администраторского Mini App; только администратор в личном чате. |
| `/login` | Device-code login; только администратор в личном чате. |
| `/limits` | 5-часовой и недельный остаток VPS-аккаунта; только администратор в личном чате. |
| `/project_create <project> <primary_owner_id> <repo>` | Создать пустой управляемый Git Project; только администратор в личном чате. |
| `/project_clone <project> <primary_owner_id> <repo> <git_url>` | Клонировать управляемый Git Project; только администратор в личном чате. |
| `/topics` | Список обнаруженных Telegram chats/topics и их bindings; только администратор в личном чате. |
| `/bind_topic <chat_id> <topic_id> <project> [workspace]` | Удалённо привязать обнаруженный topic; только администратор в личном чате. |
| `/projects` | Список доступных отправителю Project и Workspace. |
| `/bind <project> [workspace]` | Привязать текущий topic. |
| `/status` | Версия SUMMING, account, plan, binding, active/pending. |
| `/files` | Deep link в личный чат и Telegram Mini App Project Viewer. |
| `/steer <текст>` | Направить текст в текущий Codex turn. |
| `/cancel` | Прервать активный turn topic. |
| `/new` | Начать новый Codex thread в topic. |
| `/remember <факт>` | Добавить факт в Project memory. |
| `/memory`, `/memory_status` | Показать видимое состояние Team Space. |
| `/memory_me` | Показать собственные evidence и связанные knowledge items. |
| `/memory_forget_me` | Redact собственных events, удалить связанные выводы, пометить summary для пересборки и остановить будущий ingest. |
| `/memory_resume_me` | Возобновить будущий ingest без восстановления удалённого. |
| `/memory_pause`, `/memory_resume` | Приостановить/возобновить Space; только администратор. |
| `/review` | Follow-up с просьбой проверить незакоммиченные изменения и не менять файлы. |
| `/restart` | Выйти с кодом 42; только администратор, systemd перезапустит. |
| `/panic` | Только администратор; немедленно выйти с кодом 99 без acknowledgement и автоматического рестарта. |

При `/bind` без Workspace используется `default_workspace` Project.
Project owner не может перепривязать topic, уже принадлежащий другому Project;
администратор может работать со всеми bindings.
Перепривязка topic к другому Project/Workspace сбрасывает Codex thread и путь
worktree в SQLite, очищает active state и помечает ожидающие inputs как
`consumed`, потому что старый контекст не должен пересекать границу проекта.
Физический worktree при этом не удаляется; правила его повторного использования
описаны в разделе 5.

## 11. Состояние на диске

При значениях путей по умолчанию состояние выглядит так:

```text
$SUMMING_DATA_DIR/
├── config.toml                    # default SUMMING_CONFIG
├── state.sqlite3
├── state.sqlite3-wal
├── state.sqlite3-shm
├── codex/                         # default CODEX_HOME, включая auth
├── memory/
│   └── identity.md
├── projects/
│   └── <project-id>/
│       ├── memory.md
│       └── memory-conflicts/
├── repositories/                  # управляемые локальные Git repositories
│   └── <project-id>/<repo-id>/
├── run-artifacts/                 # before/after snapshots и patch каждого editor Run
│   └── <conversation-id>/<run-id>/
└── worktrees/                     # default SUMMING_WORKTREE_ROOT
    └── <conversation-id>/
```

`SUMMING_CONFIG`, `CODEX_HOME` и `SUMMING_WORKTREE_ROOT` могут указывать за
пределы data dir. Единственный жёстко расположенный внутри data dir файл базы —
`state.sqlite3`; identity и project memory также всегда строятся от
`SUMMING_DATA_DIR`.

SQLite хранит:

- binding `chat_id/topic_id → project/workspace`;
- editor и read-only Codex thread id;
- активный turn и Telegram stream message id;
- pending steer/follow-up с `access_mode`, `response_mode`, Telegram user id и
  типизированными metadata вложений;
- историю Run: access/response mode, prompt, response, status, error и timestamps;
- управляемые Projects, Workspaces, primary owner и списки совладельцев;
- обнаруженные Telegram chats/topics, наблюдаемые авторы и последний membership
  event бота;
- Team Spaces, Sources, People и не объединяемые автоматически provider identities;
- event journal с replies, edits, reactions, membership и attachment metadata;
- knowledge с confidence, visibility, temporal validity, evidence и supersession;
- understanding/intervention audit и opt-out/retention state;
- последний подтверждённый Telegram update offset.

Основные таблицы:

| Таблица | Содержимое |
|---|---|
| `conversations` | Binding, editor/read-only threads, active turn, stream message и worktree path. |
| `pending_inputs` | Очередь, access/response mode, Telegram user id, attachment JSON и состояние обработки. |
| `runs` | Access/response mode, prompt, response, status, error и время выполнения. |
| `runtime_state` | Сейчас только Telegram update offset. |
| `managed_projects` | Динамический Project, его primary owner и default Workspace. |
| `managed_project_owners` | Все owners Project; primary owner всегда входит в этот список. |
| `managed_workspaces` | Абсолютные пути управляемых repositories. |
| `telegram_chats` | Метаданные чата, membership status бота и последний membership event. |
| `telegram_topics` | Обнаруженные topic id, доступные названия и timestamps. |
| `telegram_users` | Последние доступные Telegram profile metadata с устойчивым numeric user ID. |
| `telegram_topic_users` | Activity по ключу `(chat_id, topic_id, user_id)`: счётчик сообщений и first/last seen. |
| `team_spaces`, `team_sources` | Durable boundary команды и transport sources. |
| `team_people`, `team_identities` | Люди и provider identities с observation preference. |
| `team_events` | Нормализованный evidence journal и redaction state. |
| `team_knowledge`, `team_knowledge_evidence`, `team_knowledge_supersessions` | Производные выводы, provenance и исправления. |
| `team_synthesis_runs`, `team_interventions` | Audit unified understanding runs (physical legacy table name) и реально подготовленных сообщений. |
| `team_space_projects` | Отдельно подтверждённые связи Space с Project. |

WAL сохраняет совместимость с существующей базой и допускает независимое чтение
диагностическими инструментами. В самом runtime короткие синхронные SQLite-запросы
выполняются в одном Node.js event loop.

## 12. Конфигурация

Полный пример находится в [config.example.toml](config.example.toml).
TOML остаётся authority для статических администраторских проектов. Управляемые
Telegram-проекты находятся в SQLite и не записываются обратно в TOML.

### 12.1. TOML

| Ключ | Назначение | Значение по умолчанию |
|---|---|---|
| `agent.model` | Явная Codex model; пусто = default. | пусто |
| `agent.effort` | Reasoning effort. | `medium` |
| `agent.max_parallel_conversations` | Общий предел параллельных topics. | 4 |
| `agent.stream_interval_sec` | Частота edit Telegram. | 1.0 |
| `agent.participant_rate_limit_messages` | Явных direct Q&A одного участника на окно. | 12 |
| `agent.participant_rate_limit_window_sec` | Длина rate-limit окна. | 60 |
| `agent.network_access` | Сеть внутри Codex sandbox. | true |
| `team_memory.enabled` | Локальный Team Space journal и privacy commands. | true |
| `team_memory.model_egress_enabled` | Consent-gated Conversation Understanding Loop в Codex. | false |
| `team_memory.understanding_quiet_sec` | Trailing quiet window одного Source. | 20 |
| `team_memory.understanding_max_wait_sec` | Hard deadline непрерывного episode. | 90 |
| `team_memory.understanding_max_events` | Event cap и немедленный trigger batch. | 40 |
| `team_memory.orientation_event_threshold` | Минимум evidence до первого orientation. | 50 |
| `team_memory.intervention_cooldown_sec` | Минимальный интервал proactive replies. | 3600 |
| `team_memory.raw_retention_days` | Дни хранения raw evidence; 0 = бессрочно. | 365 |
| `team_memory.announce_on_join` | Admission notice при добавлении в группу. | true |
| `codex_usage.profile_enabled` | Обновлять short description Telegram-бота. | true |
| `codex_usage.refresh_interval_sec` | Интервал перечитывания App Server limits. | 900 |
| `codex_usage.timezone` | IANA timezone для времени сброса. | `Europe/Moscow` |
| `transcription.provider` | `openai` или опциональный `groq`. | `openai` |
| `transcription.model` | Модель выбранного provider. | `gpt-transcribe` |
| `transcription.max_file_bytes` | Лимит Telegram download. | 20000000 |
| `health.port` | Порт health server. | 8765 |
| `viewer.port` | Loopback-порт Project Viewer. | 8766 |
| `viewer.public_url` | Публичный HTTPS URL Mini App. | пусто |
| `viewer.auth_max_age_sec` | Максимальный возраст Telegram initData. | 900 |
| `viewer.runner_socket` | Unix socket изолированного runner. | `/run/summing-runner/runner.sock` |
| `projects.<id>.name` | Отображаемое имя. | id |
| `projects.<id>.default_workspace` | Workspace для короткого `/bind`. | первый |
| `projects.<id>.self_change` | Пометка собственного репозитория. | false |
| `...workspaces.<id>.path` | Абсолютный локальный путь. | обязателен |

Project/Workspace id имеют длину от 1 до 64 символов, начинаются с
`[a-z0-9]`, а дальше допускают `[a-z0-9._-]`. Должен существовать хотя бы один
Project и один Workspace в нём. Пути проверяются на абсолютность при старте, но
существование каталога проверяется только при подготовке конкретного Run.
Допустимые диапазоны: parallel conversations — 1–32, stream interval — 0.5–10
секунд, participant batch — 5–120 секунд, participant messages — 1–100,
rate-limit window — 10–3600 секунд, Codex usage refresh — 60–86400 секунд,
health port — 1–65535. `codex_usage.timezone` проверяется через `Intl` при старте.

### 12.2. Environment

Секреты и системные пути находятся в
[summing.env.example](summing.env.example):

| Переменная | Назначение |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Обязательный BotFather token. |
| `TELEGRAM_OWNER_ID` | Обязательный numeric user id администратора. |
| `TRANSCRIPTION_PROVIDER` | Override provider: `openai` или `groq`. |
| `TRANSCRIPTION_MODEL` | Override модели выбранного provider. |
| `OPENAI_API_KEY` | Секрет OpenAI для дефолтной транскрипции voice/audio. |
| `GROQ_API_KEY` | Секрет Groq для транскрипции voice/audio. |
| `SUMMING_DATA_DIR` | Корень durable state. |
| `SUMMING_CONFIG` | Путь к TOML. |
| `SUMMING_WORKTREE_ROOT` | Каталог conversation worktrees. |
| `CODEX_HOME` | Выделенное состояние/auth Codex. |
| `CODEX_BIN` | Путь или executable name команды `codex`. |
| `NODE_ENV` | Режим Node.js; в production выставляется `production`. |
| `SUMMING_VIEWER_URL` | Override публичного HTTPS URL Viewer. |
| `SUMMING_VIEWER_LOCAL_TOKEN` | Bearer token только для доступа через SSH tunnel. |
| `SUMMING_RUNNER_SOCKET` | Unix socket project runner. |

Значения по умолчанию: `SUMMING_DATA_DIR=~/summing/data`, config —
`<data>/config.toml`, worktrees — `<data>/worktrees`, `CODEX_HOME=<data>/codex`,
`CODEX_BIN=codex`. `CODEX_BIN` также можно задать как `agent.codex_binary` в TOML,
но environment имеет приоритет. `TELEGRAM_OWNER_ID` должен быть положительным
безопасным JavaScript integer. Все управляемые repositories создаются внутри
`<data>/repositories`; отдельная переменная пути намеренно не предусмотрена.
`NODE_ENV` самим runtime не читается.

Не используйте общий пользовательский `~/.codex` как `CODEX_HOME`: SUMMING
ожидает отдельный auth-only каталог. Для ручной установки обязательно установите
[deploy/codex-requirements.toml](deploy/codex-requirements.toml) в
`/etc/codex/requirements.toml`; `cloud-init` и `deploy/activate.sh` делают это
автоматически.

Для unit-файла из примера EnvironmentFile должен принадлежать `root:summing` и
иметь mode `0640`; `config.toml` принадлежит пользователю `summing` и имеет mode
`0600`.

## 13. Развёртывание на VPS

### 13.1. Системные требования

- Linux с systemd;
- Node.js 24+ и npm;
- Git;
- curl, `file`, `unzip`;
- system `bubblewrap` и AppArmor profile `bwrap-userns-restrict` на Ubuntu 24.04;
- Codex CLI с командой `app-server`;
- исходные репозитории на локальном диске VPS;
- исходящий HTTPS к Telegram, OpenAI/Codex и выбранному transcription provider.

Установите Codex по [официальной инструкции](https://developers.openai.com/codex/cli)
и проверьте:

```bash
codex --version
codex app-server --help
```

### 13.2. Рекомендуемый путь: Hetzner cloud-init

Для нового Hetzner Cloud VPS используйте Ubuntu 24.04 x86-64, обязательно
выберите SSH-ключ и вставьте целиком
[deploy/cloud-init.yaml](deploy/cloud-init.yaml) в поле **Cloud config**. Bootstrap:

- устанавливает Git, curl, rsync, SQLite CLI, `file`, `unzip`, system
  `bubblewrap`, AppArmor profiles, UFW и unattended upgrades;
- устанавливает зафиксированный Node.js 24 LTS из официального binary archive и
  проверяет SHA-256 по официальному `SHASUMS256.txt`;
- устанавливает актуальный Codex CLI официальным standalone installer;
- создаёт непривилегированного пользователя `summing` и каталоги данных;
- создаёт 4 GiB swap со `swappiness=10` для VPS с 4 GiB RAM;
- оставляет снаружи только SSH 22/tcp, запрещает password login и сохраняет
  root login только по SSH-ключу;
- включает ежедневные security updates;
- не запускает SUMMING до загрузки исходников и добавления credentials.

Cloud-init user-data сохраняется в metadata Hetzner и локально на VPS. Поэтому в
нём намеренно нет Telegram token, transcription credentials, приватного Git deploy key
или содержимого репозитория.

Репозиторий приватный и не клонируется из cloud-init. Дождитесь окончания
bootstrap и перенесите текущий checkout вместе с `.git`:

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
```

`.git` нужен для постоянных worktree, веток и self-change workflow; не заменяйте
эту передачу архивом только рабочих файлов. После загрузки войдите на VPS,
заполните credentials и активируйте инсталляцию:

```bash
ssh -i ~/.ssh/summing-deploy root@"${summing_server}"
nano /etc/summing/summing.env
# TELEGRAM_BOT_TOKEN=...
# TELEGRAM_OWNER_ID=...
# OPENAI_API_KEY=...
/opt/summing/deploy/activate.sh
```

[deploy/activate.sh](deploy/activate.sh) создаёт production config при его
отсутствии, проверяет credentials, выполняет `npm ci`, lint, тесты, production
build и `npm prune --omit=dev`, устанавливает units, создаёт первоначальный
`/opt/summing-current` и ждёт успешный loopback health check. Существующие
`config.toml`, application environment и deploy environment он не
перезаписывает, поэтому сценарий можно безопасно повторить после обновления
кода.

После запуска отправьте боту `/login`, завершите ChatGPT device-code flow, затем
в личном чате создайте управляемый Project через `/project_create` или
`/project_clone`. Каждый назначенный owner должен отправить боту `/start`, после чего
можно создать forum group/topics и выполнить `/bind`.

### 13.3. Ручная подготовка пользователя и каталогов

```bash
sudo useradd --system --create-home --home-dir /var/lib/summing summing
sudo install -d -o summing -g summing -m 0700 /var/lib/summing/data
sudo install -d -o root -g summing -m 0750 /etc/summing
```

Расположите код, например, в `/opt/summing`, а статические проектные репозитории —
в `/srv/projects`. Пользователь `summing` должен иметь права на Workspace из
конфига. Управляемые Telegram-repositories runtime создаёт сам внутри data dir.

### 13.4. Node.js и сборка

```bash
cd /opt/summing
npm ci
npm run build
npm prune --omit=dev
```

Production запускает скомпилированный `dist/src/index.js`. В runtime используется
встроенный `fetch` для Telegram и встроенный `node:sqlite`; единственная внешняя
production-зависимость — компактный TOML parser `smol-toml`. TypeScript и Node.js
types нужны только для сборки и тестов. После `npm prune --omit=dev` повторная
сборка потребует снова выполнить `npm ci`.

На Node.js 24 импорт `node:sqlite` может один раз вывести `ExperimentalWarning`.
Это ожидаемо: API уже не требует feature flag, но в LTS-ветке ещё сохраняет
экспериментальную маркировку. Выбор сделан сознательно, чтобы не добавлять нативный
SQLite addon и toolchain для его сборки на VPS; используемая синхронная поверхность
покрыта профильными тестами.

### 13.5. Конфиг и секреты

```bash
sudo cp deploy/config.production.toml /var/lib/summing/data/config.toml
sudo cp summing.env.example /etc/summing/summing.env
sudo chown summing:summing /var/lib/summing/data/config.toml
sudo chown root:summing /etc/summing/summing.env
sudo chmod 0600 /var/lib/summing/data/config.toml
sudo chmod 0640 /etc/summing/summing.env
```

Отредактируйте token, Telegram ID администратора, `CODEX_BIN` и пути статических
Workspace.

### 13.6. Systemd

Скопируйте [deploy/summing.service](deploy/summing.service):

```bash
sudo cp deploy/summing.service /etc/systemd/system/summing.service
sudo systemctl daemon-reload
sudo systemctl enable --now summing
```

Unit запускает `/usr/local/bin/node --enable-source-maps`, читает
`/etc/summing/summing.env`, работает от `summing:summing` с `UMask=0077` и
останавливает всю process group. Cloud-init устанавливает Node именно в этот
путь. При другом способе установки исправьте `ExecStart` до первого запуска.

Проверка:

```bash
systemctl status summing
journalctl -u summing -f
curl --fail http://127.0.0.1:8765/health
```

После первого запуска откройте личный чат с ботом, отправьте `/start` и откройте
**Управление**. Завершите ChatGPT device-code flow через резервную команду
`/login`, создайте Project в Mini App, затем создайте forum group/topics,
отправьте в них по сообщению и выберите binding в интерфейсе. `/project_create`,
`/project_clone` и `/bind_topic` остаются резервным совместимым путём.

### 13.7. Атомарные обновления из origin

Production не запускается непосредственно из изменяемого Git checkout.
`summing.service`, runner и scheduled runner CLI используют symlink
`/opt/summing-current`. Первоначально он указывает на `/opt/summing`; после
первого обновления — на неизменяемый каталог
`/opt/summing-releases/<full-commit-sha>`.

Один `summing-deploy.service` обслуживает два источника запроса:

- `summing-deploy.timer` проверяет `origin/master` каждые 10 минут;
- администраторская кнопка **Управление → Настройки SUMMING → Обновиться сейчас**
  атомарно обновляет
  `/var/lib/summing/deploy/request.json`, который наблюдает
  `summing-deploy.path`.

Request-файл не содержит команды или revision и не интерпретируется worker:
каждый запуск самостоятельно получает и проверяет текущий remote ref. Deploy
API `/api/viewer/admin/deployment` не зависит от Project/Conversation, требует
Telegram Mini App signature и точный `TELEGRAM_OWNER_ID`; project owner получает
`403`. Локальный SSH-tunnel bearer token считается
администраторским доступом, как и для остальных Viewer diagnostics.

Порядок deployment:

1. под process-wide `flock` получить закреплённый `origin/master` от имени
   `summing`, не меняя index, branch или working tree `/opt/summing`;
2. отклонить неожиданный remote URL и non-fast-forward переход;
3. экспортировать точный commit через `git archive` во временный release;
4. от имени отдельного `summing-builder`, не имеющего доступа к application
   secrets и data dir, последовательно выполнить `npm ci`, lint, тесты и
   production prune, публикуя текущую фазу;
5. дождаться `active = 0`, атомарно заменить symlink и перезапустить runner и
   основной сервис;
6. проверить оба loopback health endpoints; при ошибке вернуть прежний symlink
   и повторно запустить старый release;
7. сохранить JSON-состояние для Mini App и оставить последние пять releases.

Каждая значимая завершённая попытка (`succeeded`, `failed` или migration
`waiting`) попадает в ограниченную историю из 20 записей. Для ошибки worker
сохраняет фазу, категорию и exit code. TAP-вывод тестов сворачивается в общее
число passed/failed, не более 20 названий упавших тестов и очищенный хвост лога
не более 12 000 символов. Полные application secrets в builder не передаются;
Mini App валидирует и дополнительно ограничивает все поля перед показом. Обычные
проверки актуального SHA историю не засоряют. Несовпавший approved origin теперь
завершается явным `failed/source-verification`, а не остаётся в `checking`.

После полного `succeeded` worker атомарно кладёт структурированное
`update_succeeded` событие в `/var/lib/summing/deploy/events`; ошибки `lint` и
`tests` создают `update_failed` с target version/SHA и уже ограниченной test
summary. Runtime читает outbox каждые пять секунд, отправляет событие только в
личный чат `TELEGRAM_OWNER_ID` и удаляет файл после успешного Telegram API call.
При временной ошибке файл остаётся для повторной доставки. `logTail` намеренно не
рендерится в Telegram. На границе обновления новый runtime сначала фиксирует
активный attempt из `state.json` до открытия health endpoint: это позволяет ему
сообщить об установке даже тогда, когда запустивший rollout worker был из
предыдущего release и ещё не умел создавать outbox event.

`state.json` и `history.json` принадлежат `root:summing` с режимом `0640`.
Каталог deployment имеет sticky mode `1770`: приложение может атомарно обновлять
свой `request.json`, но не может подменить root-owned state/history или временный
файл worker. Все root-записи создаются через `mktemp` и атомарный `rename`.

Legacy Connections → project environment cutover использует контролируемую
двухтактную схему. Если импорт уже существует, но установленный legacy project
config ещё не содержит разрешённую release-версией сеть, первый deploy hook
атомарно переносит только `network: true`, сохраняя `envPath`, и публикует
состояние `waiting`, а не ложный `failed`. Coordinator выполняет Validate и Dry
run на одной encrypted environment revision; следующий deploy tick принимает
только `verified.json`, совпадающий с активной schedule revision, и затем
транзакционно удаляет `envPath`, legacy route и broker. Любая другая ошибка
hook остаётся состоянием `failed`. При старте и после завершения каждой job
runner оставляет не более 100 завершённых job-каталогов на Project;
queued/running и непонятные операторские каталоги автоматически не удаляются.
Отдельный лимит подробных Dry run artifacts — 30.

Root-only настройки находятся в `/etc/summing/deploy.env`. В частности,
`SUMMING_DEPLOY_EXPECTED_REMOTE` должен точно совпадать с `git remote get-url
origin`; значение по умолчанию —
`git@summing.github.com:summing-org/summing.git`. У пользователя `summing`
должен быть read-only deploy key и заранее проверенный SSH host key. Application
secrets из `/etc/summing/summing.env` worker не загружает.

Диагностика и ручной запуск того же безопасного контура:

```bash
systemctl list-timers summing-deploy.timer
systemctl status summing-deploy.path summing-deploy.timer summing-deploy.service
journalctl -u summing-deploy --since today
sudo systemctl start summing-deploy.service
cat /var/lib/summing/deploy/state.json
cat /var/lib/summing/deploy/history.json
find /var/lib/summing/deploy/events -maxdepth 1 -type f -print
```

### 13.8. Одноразовая миграция существующего 8.x host

Версия 9.0 меняет не только UI identity, но и весь operational namespace:
application/builder/runner users, home и config directories, environment
variables, runtime socket, release paths, systemd units и GitHub repository.
Поэтому старый timer не считается migration mechanism: его health rollback
защищает работающий host от частично переименованного release.

До начала должны существовать:

1. опубликованный `master` актуальной версии SUMMING 9.x;
2. repository `git@summing.github.com:summing-org/summing.git`, доступный тому же
   read-only deploy key;
3. предпочтительно — проверенный полный snapshot VPS; при явном отказе оператор
   принимает риск ручного восстановления только из локального recovery bundle;
4. ноль активных Codex runs и чистый mutable checkout.

Обновите checkout и отдельно выполните preflight. Разделённая строка ниже
нужна только для адресации pre-9 installation; после успешного перехода такой
identity на host больше не существует.

```bash
legacy_name="sum""mate"
legacy_repo="/opt/${legacy_name}"
sudo -u "${legacy_name}" git -C "${legacy_repo}" fetch origin master
sudo -u "${legacy_name}" git -C "${legacy_repo}" merge --ff-only origin/master
sudo "${legacy_repo}/deploy/migrate-host-to-summing" --check
```

`--check` ничего не меняет. Он валидирует source/target users и paths, чистоту
checkout, отсутствие deployment worker и active runs, доступность нового remote,
конфликты conversation branches/runtime directories и collision self-project IDs
в SQLite. Apply требует либо подтверждения внешнего snapshot, либо отдельного
явного waiver; эти режимы взаимоисключающие:

```bash
# Рекомендуемый режим
sudo env SUMMING_BACKUP_CONFIRMED=1 \
  "${legacy_repo}/deploy/migrate-host-to-summing" --apply

# Если оператор осознанно отказался от VPS snapshot
sudo env SUMMING_SNAPSHOT_WAIVED=1 \
  "${legacy_repo}/deploy/migrate-host-to-summing" --apply
```

Apply сначала останавливает polling, deploy timers и runner, затем создаёт
`/var/backups/summing-host-migration-<UTC>` с manifest, configuration copy,
consistent SQLite backup, прежними units/current symlink/releases. Manifest
фиксирует `backup_mode=snapshot-confirmed` или `backup_mode=snapshot-waived`.
После этого
он сохраняет UID/GID при переименовании Unix accounts, переносит durable/config
paths, переписывает только operational paths и `SUMMING_*` keys, обновляет
SQLite references, linked-worktree metadata, runtime directory, excludes и
conversation branch. Незакоммиченные workspace files не копируются и не
пересоздаются: остаётся тот же worktree.

Финальный этап использует обычный `deploy/activate.sh`, запускает rootless Docker
под сохранённым runner UID, устанавливает новые units и проверяет application и
runner health. При ошибке после начала apply не пытайтесь смешивать namespaces.
В confirmed-режиме остановите units и восстановите VPS snapshot. В waiver-режиме
snapshot отсутствует: остановите SUMMING units и восстанавливайте host вручную
из root-only recovery bundle; этот путь рискованнее и не гарантирует такой же
атомарности, как полный snapshot.

## 14. Операционное управление

В проекте нет собственного CLI. Операционные команды стандартные:

```bash
sudo systemctl start summing
sudo systemctl stop summing
sudo systemctl restart summing
sudo systemctl status summing
journalctl -u summing --since today
journalctl -u summing -f
curl --fail --silent http://127.0.0.1:8765/health
curl --fail --silent http://127.0.0.1:8765/state
```

`/health` и `/state` сейчас являются алиасами и возвращают один компактный JSON:

```json
{
  "ok": true,
  "version": "9.8.8",
  "codex_running": true,
  "auth": "chatgpt",
  "plan": "plus",
  "codex_limits": {
    "weekly_remaining_percent": 68,
    "weekly_resets_at": 1787260800,
    "updated_at": 1786650000
  },
  "transcription": {
    "provider": "openai",
    "configured": true,
    "model": "gpt-transcribe"
  },
  "telegram_last_poll": 1786450000.0,
  "conversations": 4,
  "active": 2,
  "pending": 1
}
```

Endpoint не предназначен для публикации в Интернет. Проверку выполняют локально
через curl или monitoring agent на VPS. HTTP status равен 200, только если
`codex app-server` запущен и runtime не начал остановку; иначе возвращается 503.
Поле `ok` не проверяет наличие ChatGPT-авторизации, свежесть Telegram poll или
доступность Workspace.

Поля `conversations`, `active` и `pending` — глобальные счётчики всей SQLite
базы, а не статистика текущего Telegram topic.

### Exit codes

| Код | Значение для systemd |
|---|---|
| 0 | Штатная остановка, автоматического рестарта нет. |
| 1 | Необработанная startup/runtime error или неожиданный выход Codex; systemd перезапустит сервис. |
| 2 | Ошибка конфигурации; автоматический рестарт запрещён. |
| 42 | Запрошен `/restart`, `Restart=on-failure` поднимет сервис. |
| 99 | `/panic`; `RestartPreventExitStatus=99` запрещает рестарт. |

При SIGTERM прерывается Telegram long poll, останавливается Codex, завершаются
conversation processors, health server и SQLite. Run, прерванный остановкой
процесса, помечается `interrupted`. Git subprocess получает AbortSignal и при
остановке принудительно завершается. При `/panic` Codex сразу получает `SIGKILL`;
Telegram acknowledgement намеренно не отправляется.

После аварийного завершения prompt, оставшийся в статусе `running`, возвращается
в начало follow-up queue, соответствующий Run помечается `interrupted`, active
state очищается, а оставшиеся `steer` переводятся в `followup`. Это даёт
at-least-once recovery: prompt может выполниться повторно, причём сделанный до
сбоя Git diff остаётся в постоянном worktree.

## 15. Backup и восстановление

### 15.1. Что обязательно сохранять

- `config.toml`;
- `state.sqlite3*`;
- `CODEX_HOME`;
- `memory/`;
- `projects/`;
- `repositories/` со всеми управляемыми Git refs и незапушенными commits;
- `SUMMING_WORKTREE_ROOT`, если нужно сохранить незакоммиченные изменения;
- `run-artifacts/`, `/etc/summing-runner` и `/var/lib/summing-runs` при
  использовании Viewer/runner;
- `repository-credentials/`, если встроенные deploy keys должны пережить
  восстановление без перевыпуска на стороне Git-сервиса;
- исходные Git-репозитории и их refs, если они не гарантированно находятся в
  origin.

Чистый worktree можно восстановить из Git refs, но незакоммиченные файлы и index
живут только в самом worktree. Незапушенные ветки и commits находятся в общем Git
directory исходного репозитория. Поэтому для полного восстановления активной
работы нужны и исходный репозиторий с `.git`, и соответствующий worktree. Если
config, Codex home или worktree root вынесены за data dir, backup обязан включать
фактические пути из environment.

### 15.2. Согласованный backup

Самый простой безопасный порядок:

```bash
sudo systemctl stop summing
# сделать snapshot /var/lib/summing/data и локальных Git-репозиториев
sudo systemctl start summing
```

Для online backup SQLite следует использовать механизм SQLite backup, а не
копировать только основной файл без WAL/SHM.

### 15.3. Восстановление

1. восстановить репозитории и Git refs по прежним абсолютным путям;
2. восстановить data dir и permissions;
3. проверить `config.toml` и `CODEX_BIN`;
4. запустить сервис;
5. проверить journal, health и `/status`;
6. если Codex thread больше не возобновляется, SUMMING автоматически создаст
   новый и сохранит Project memory/worktree.

## 16. Диагностика

### Сервис постоянно рестартует

```bash
systemctl status summing
journalctl -u summing -n 200 --no-pager
```

Частые причины: отсутствующий config, неверный `CODEX_BIN`, занятый health port,
ошибка Telegram token или permissions.

### `Codex не авторизован`

Отправьте `/login` в личном чате и завершите flow. Проверьте, что
`CODEX_HOME` постоянный и доступен пользователю systemd; не запускайте ручной
login под другим Unix-user/Home.

### Topic не отвечает

1. для администратора проверить sender id и `TELEGRAM_OWNER_ID`, для Project
   owner — назначение проекта через администраторский `/projects`;
2. выполнить `/projects`;
3. выполнить `/bind <project> [workspace]`;
4. проверить `/status`;
5. посмотреть journal;
6. проверить, не достигнут ли глобальный предел параллельности.

### `/project_create` или `/project_clone` не сработал

Обе команды принимаются только от `TELEGRAM_OWNER_ID` в личном чате. ID Project
и repository должны соответствовать `[a-z0-9][a-z0-9._-]{0,63}`, owner id должен
быть положительным числом. Если каталог
`$SUMMING_DATA_DIR/repositories/<project>/<repo>` остался после прерванной
операции, runtime намеренно не удаляет его и просит администратора сначала
проверить содержимое. Для private clone проверьте non-interactive credentials
пользователя `summing`; `GIT_TERMINAL_PROMPT=0` запрещает зависнуть на запросе
пароля.

### Обычное сообщение «пропало» во время ответа

Для Project owner оно поставлено без acknowledgement в direct follow-up queue;
после текущего Run такие сообщения объединяются в следующий turn. Для обычного
участника отсутствие ответа штатно: обычное сообщение стало Team Space evidence,
а единый understanding loop мог выбрать `silent`. Для гарантированного Q&A нужно
упомянуть `@username_бота` или ответить на сообщение бота. Если не срабатывает и
это, проверьте Privacy Mode/права администратора бота и direct rate limit. `/status`
показывает direct `pending` текущего topic владельцу, а health status — число
scheduled/active understanding loops администратору.

### Steer не изменил текущий ответ

Turn мог завершиться до доставки. Запись не удаляется и будет выполнена как
follow-up. Для явного поведения используйте `/steer` или reply на текущий stream.

### Git worktree не создаётся

Проверьте:

```bash
git -C /path/to/repo status
git -C /path/to/repo worktree list
git -C /path/to/repo branch --list 'summing/*'
```

Целевой каталог не должен содержать посторонние файлы. SUMMING не удаляет его
автоматически. Если journal сообщает, что worktree принадлежит другому
репозиторию, сравните исходный repo и `$SUMMING_WORKTREE_ROOT/tg-<hash>` через
`git worktree list`; дальнейшая очистка — явная операторская операция.

### Panic stop

После `/panic` состояние ожидаемо:

```bash
systemctl status summing
```

Вернуть сервис может только администратор:

```bash
sudo systemctl start summing
```

## 17. Разработка и проверка

Структура репозитория:

```text
src/
├── index.ts                # signals и process entry
├── config.ts               # TOML/env validation
├── attachment-service.ts   # Telegram spool + OpenAI/Groq transcription boundary
├── team-memory.ts          # provider-neutral Team Space event normalization and views
├── runtime.ts              # Telegram ↔ Conversation ↔ Codex orchestration
├── async-primitives.ts     # semaphore и deferred completion
├── telegram-api.ts         # минимальный Bot API client на fetch
├── codex-app-server.ts     # типизированная JSONL/RPC boundary
├── project-catalog.ts      # managed Projects, owners и Git provisioning
├── git-inspector.ts        # safe tree/file/diff/snapshot/archive boundary
├── repository-credentials.ts # per-project SSH deploy keys outside worktrees
├── project-viewer.ts       # Mini App static/API loopback server
├── viewer-auth.ts          # Telegram initData и local bearer validation
├── project-runner-*.ts     # Unix socket client/server/CLI
├── run-artifacts.ts        # before/after patches editor Runs
├── state-store.ts          # SQLite authority
├── workspace-manager.ts    # memory и Git worktrees
└── health-server.ts        # loopback HTTP

tests/
├── brand.test.ts
├── config.test.ts
├── deploy-assets.test.ts
├── project-catalog.test.ts
├── git-inspector.test.ts
├── repository-credentials.test.ts
├── project-runner.test.ts
├── viewer-auth.test.ts
├── attachment-service.test.ts
├── runtime-access.test.ts
├── runtime-attachments.test.ts
├── state-store.test.ts
├── codex-app-server.test.ts
├── telegram-api.test.ts
├── team-memory.test.ts
└── workspace-manager.test.ts

deploy/
├── cloud-init.yaml         # bootstrap чистого Ubuntu/Hetzner VPS
├── activate.sh             # сборка, установка unit и первый запуск
├── migrate-host-to-summing # guarded one-time 8.x host migration
├── install-project-operations.sh # rootless Docker, Caddy, runner и timer
├── config.production.toml  # минимальный production config для SUMMING
├── summing.service         # основной Telegram runtime
├── summing-runner.service  # изолированный Docker runner
└── summing-ash-seo.timer   # pinned daily schedule
```

Локальные проверки:

Репозиторий фиксирует major runtime в `.node-version`. Все lifecycle-команды
сначала выполняют быстрый guard и отказываются компилировать или запускать тесты
на Node.js ниже 24; это предотвращает поздние ложные падения импорта `node:sqlite`.
В Codex перед первой npm-командой нужно проверить `node --version` и при
необходимости активировать Node из workspace dependencies.

```bash
make build
make test
make lint
```

`make test` сначала компилирует TypeScript, затем запускает test suite через
стандартный `node:test`. Они проверяют config, SQLite/restart recovery, Telegram
splitting, project-owner ACL, JSONL-протокол и формы Codex v2, создание и clone
управляемых repositories, локальный Git worktree и merge project memory. Для
suite не нужен Telegram token, OpenAI/Groq account или сеть; полноценного
Telegram/OpenAI/Groq end-to-end теста в репозитории нет.

При изменении протокола Codex необходимо сверяться с актуальной официальной
документацией. `npm run codex:types` генерирует в игнорируемый каталог
`.codex-protocol/` точные TypeScript bindings установленной версии CLI для такой
сверки. Runtime намеренно держит только используемый узкий контракт, а не 700+
сгенерированных типов. При изменении state schema миграция должна сохранять
существующие Conversation, pending input и run history.

## 18. Границы текущей версии

Это намеренные ограничения, а не скрытые обещания:

- один Telegram administrator id; у управляемого Project один обязательный
  primary owner и любое число совладельцев;
- один общий ChatGPT/Codex account администратора;
- documents/ZIP и voice/audio принимаются до Telegram download limit 20 МБ;
- один бот и один SQLite;
- нет multi-host coordination;
- нет автоматического commit/merge/push и force push; ручные Pull/Push текущей
  ветки и fast-forward её `HEAD` в существующий `origin/master` доступны owner и
  администратору в Project Viewer;
- смена primary owner и управление совладельцами доступны глобальному
  администратору в Admin Mini App; удаления Project и добавления второго
  repository через Telegram пока нет;
- Viewer публикуется только через явно настроенный HTTPS proxy и owner ACL;
- нет per-message approval UI;
- non-Git Workspace сериализует Runs, но не изолирует изменения между ними;
- Project memory — простой Markdown, не vector database;
- `/review` — prompt-level запрет изменений в обычном write-enabled permission profile;
- health не является полной readiness-проверкой;
- config не перечитывается без рестарта;
- версионированного механизма миграций SQLite schema нет; additive tables и
  columns создаются idempotent `CREATE TABLE IF NOT EXISTS`/`ALTER TABLE`.

Новая возможность должна добавляться только при конкретном пользовательском
сценарии. Предпочтительный путь развития — улучшать надёжность существующего
контура без накопления лишней платформенной сложности.
