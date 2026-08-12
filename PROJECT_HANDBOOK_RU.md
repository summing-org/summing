# Summate 8.3: архитектура, эксплуатация и разработка

> Версия: **8.3.0**
> Целевая среда: один Linux VPS, один администратор, владельцы проектов, один Telegram-бот.
> Последняя сверка с кодом: **12 августа 2026 года**.

Это единый технический документ о проекте. Он описывает продуктовую модель,
архитектуру, состояние на диске, протокол выполнения, авторизацию ChatGPT,
развёртывание через systemd, диагностику и разработку.

Нормативные принципы идентичности и полномочий находятся в
[BIBLE.md](BIBLE.md). Если документация расходится с исполняемым кодом, текущее
поведение определяет код, а расхождение считается дефектом документации.

## 1. Что это за проект

Summate — постоянно работающий агент с одним администратором и назначаемыми
владельцами проектов. Они общаются с ним через Telegram, а фактический агентный
цикл выполняет один общий официальный Codex App Server, авторизованный ChatGPT
account администратора.

Summate не реализует собственную LLM, набор shell-инструментов или очередной
универсальный agent framework. Его задача значительно уже:

1. связать Telegram topic с проектом и локальной рабочей областью;
2. сохранить отдельный контекст каждого диалога;
3. запустить и продолжить Codex thread;
4. передавать новые указания в активный turn или ставить их следом;
5. стримить ответ обратно в Telegram;
6. развести параллельные диалоги по отдельным Git worktree;
7. хранить минимальную общую память проекта;
8. разделить рабочий доступ владельцев и read-only Q&A участников group topic;
9. дать администратору простое операционное управление.

В результате граница ответственности выглядит так:

```text
Telegram и Summate                  Codex App Server
---------------------------------  ---------------------------------
администратор/owner/participant     модель и agent loop
binding topic → project             editor/read-only Codex threads
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
возобновляется сразу, а ambient-очередь получает новое окно агрегации. Поэтому
после рестарта работа может начаться без нового сообщения.
Если очередь пуста, runtime только ждёт Telegram updates и события Codex;
публичный HTTP-сервис не запускается.

## 3. Продуктовая модель

### 3.1. Project

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
  `/project_create` или `/project_clone`; они хранятся в SQLite и получают одного
  назначенного Telegram owner.

Администратор имеет рабочий доступ ко всем Projects. Project owner видит,
привязывает и изменяет только назначенные ему Projects. Остальные участники уже
привязанного group topic могут задавать вопросы о текущем Project, но не получают
команд или write-доступа. Перезапуск после создания не нужен.

### 3.2. Workspace

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
Summate сам создаёт или клонирует Git-репозиторий в
`$SUMMATE_DATA_DIR/repositories/<project-id>/<repo-id>`. Он настраивает локальную
Git identity `Summate <summate@localhost>` и гарантирует существование начального
commit, чтобы conversation worktree можно было создать даже для нового или
пустого remote.

Summate не содержит GitHub App или PR/release pipeline. Обычные remotes,
credentials и правила push принадлежат локальному Git/Codex. Token нельзя
встраивать в Git URL: для приватного remote следует настроить SSH или credential
helper пользователя systemd `summate`.

### 3.3. Conversation

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
команды и replies, поэтому на полный direct/ambient routing полагаться нельзя. См.
[официальное описание Privacy Mode](https://core.telegram.org/bots/features#privacy-mode).

В обычном приватном чате `message_thread_id` равен нулю, поэтому весь чат является
одной Conversation. Для нескольких параллельных контекстов предназначена
Telegram forum group.

### 3.4. Run

Run — один пользовательский turn внутри Conversation. Каждый Run имеет
`access_mode`: `write` для администратора/owner или `read-only` для участника, а
также `response_mode`: `direct` для явного запроса или `ambient` для фонового
семантического анализа.

Инварианты:

- у Conversation одновременно не более одного активного Run;
- разные Conversations могут работать параллельно;
- Runs одного non-Git Workspace выполняются последовательно, чтобы read-only
  снимок запрещённых путей не гонялся с editor-записью;
- глобальный предел задаёт `max_parallel_conversations`;
- Run не является отдельным долго живущим task-объектом;
- история Run хранится для диагностики, а смысловой контекст хранит Codex thread.

## 4. Маршрутизация сообщений

У `pending_inputs` есть две независимые оси: полномочие `access_mode` (`write` или
`read-only`) и намерение ответа `response_mode` (`direct` или `ambient`). Editor
inputs никогда не объединяются с participant inputs, а ambient batch никогда не
может steer активный editor turn.

### 4.1. Прямое обращение участника

Упоминание `@username_бота` или reply на сообщение самого бота получает
`response_mode=direct`. Такой input имеет приоритет над ожидающей ambient-очередью
и запускается без batch-delay. Это явный запрос на ответ, но всё ещё в отдельном
read-only thread: запускать команды или изменять Project от этого нельзя.

### 4.2. Фоновый смысловой анализ

Остальные сообщения участников получают `response_mode=ambient`. Первый input
запускает тихий таймер `participant_batch_sec`; новые сообщения до его истечения
собираются в один пакет. После таймера Codex получает JSON-массив с Telegram
message/user id и текстом, а `turn/start.outputSchema` требует строгое решение:
отвечать ли, какому исходному сообщению и каким текстом.

Ответ допустим только когда он существенно помогает обсуждению Project: это
конкретный вопрос по реализации, вероятная фактическая ошибка, блокер, риск или
решение, требующее уточнения. Приветствия, подтверждения, шутки, повторы, общая
болтовня, мнения и просьбы выполнить действие остаются без ответа. Отрицательное
или невалидное решение ничего не отправляет в Telegram. Для положительного
решения runtime дополнительно проверяет, что выбранный message id действительно
входил в пакет, ограничивает ответ одним Telegram-сообщением и отвечает reply на
него без промежуточного `⚙️ Работаю…`.

До записи в очередь действует sliding-window rate limit по паре group/user. По
умолчанию принимаются 12 сообщений за 60 секунд. Лишние ambient-сообщения
отбрасываются молча; при лишнем direct-обращении одно уведомление о лимите может
быть отправлено не чаще одного окна. Администратор и Project owner этим лимитом
не ограничены.

### 4.3. Steer

Steer меняет уже выполняющийся turn. Он создаётся:

- командой `/steer <текст>`;
- reply на одно из стриминговых сообщений текущего ответа.

Summate вызывает официальный `turn/steer` с `expectedTurnId`. После успешной
доставки запись помечается обработанной. Если steering отклонён или turn уже
закрылся, сообщение не теряется: оно остаётся и становится частью следующего
turn.

### 4.4. Follow-up владельца

Обычное сообщение во время Run не создаёт параллельную задачу в том же topic. Оно
попадает в `pending_inputs` как follow-up.

После завершения активного Run Summate:

1. забирает оставшиеся steer и все follow-up;
2. сохраняет их порядок;
3. объединяет их в один следующий prompt;
4. запускает следующий turn в том же Codex thread.

Сообщение ставится в очередь без отдельного служебного ответа, чтобы не засорять
topic.

### 4.5. Стриминг

В начале direct Run бот отправляет `⚙️ Работаю…`. Дельты
`item/agentMessage/delta` накапливаются и не чаще заданного интервала заменяют
текст этого сообщения через `editMessageText`.

Если ответ длиннее лимита Telegram, создаются дополнительные сообщения. Reply на
любую часть активного потока распознаётся как steer. На завершении выполняется
принудительный flush итогового текста. Ambient Run не стримит внутреннее
структурированное решение и публикует только выбранный полезный ответ.

### 4.6. Telegram polling и offset

Bot API опрашивается через `getUpdates` с long-poll timeout 50 секунд; runtime
запрашивает только updates типа `message`. HTTP-запрос имеет timeout 70 секунд и
до четырёх попыток. Для ответа 429 учитывается `retry_after`, ограниченный 30
секундами; остальные transport errors получают линейный backoff.

Updates обрабатываются последовательно. После каждой попытки обработки — в том
числе если handler вернул ошибку и бот смог сообщить её владельцу — следующий
offset сохраняется в SQLite. Поэтому такая ошибка не приводит к автоматическому
повтору того же Telegram update.

## 5. Параллельность и Git worktree

Несколько topics одного репозитория могут одновременно менять файлы. Использовать
один checkout для этого небезопасно, поэтому Git-Workspace получает постоянный
worktree на Conversation:

```text
$SUMMATE_WORKTREE_ROOT/
└── tg-<hash>/
    ├── .git
    ├── файлы репозитория
    └── .summate-runtime/
```

Ветка имеет вид:

```text
summate/<project-id>/<conversation-id>
```

При первом обращении ветка создаётся от текущего `HEAD` исходного checkout. При
следующих обращениях используется тот же worktree и та же ветка. Если каталог
worktree был удалён, но ветка сохранилась, она подключается без reset.

Перед повторным использованием существующего worktree Summate сравнивает его
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

Summate не делает автоматически merge, rebase, commit, push или удаление веток.
Это обычные Git-действия, которые Codex выполняет только в рамках запроса
владельца. Поэтому параллельность изолирует незавершённую работу, но интеграция
веток остаётся явным решением.

Если Workspace не является Git-репозиторием, используется исходный каталог
напрямую. Runs одного такого Workspace сериализуются: это сохраняет целостность
read-only профиля, но не даёт изоляции незавершённых изменений между
Conversations. Для параллельной разработки рекомендуется Git. Автоматическое добавление
`.summate-runtime/` в Git `info/exclude` выполняется только для Git worktree.

## 6. Контекст и память

В Summate осталось четыре уровня состояния.

### 6.1. Identity

```text
$SUMMATE_DATA_DIR/memory/identity.md
```

Файл создаётся один раз и не перезаписывается при старте. Он описывает устойчивую
идентичность агента. Доступ рекомендуется ограничить владельцем процесса.

### 6.2. Project memory

```text
$SUMMATE_DATA_DIR/projects/<project-id>/memory.md
```

Это общая долговременная память всех Conversations проекта. Перед turn её снимок
попадает в `.summate-runtime/PROJECT_MEMORY.md`.

Контекст просит агента только добавлять устойчивые факты. После Run Summate
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
.summate-runtime/
├── CONTEXT.md
└── PROJECT_MEMORY.md
```

Они исключаются через Git info/exclude и не должны попадать в commit. Это
производный контекст конкретного запуска, а не второй источник истины. Для
non-Git Workspace исключение отсутствует.

## 7. Codex App Server и ChatGPT subscription

Summate использует один execution substrate: официальный `codex app-server`.
Связь с ним идёт по JSON Lines/JSON-RPC через stdin/stdout дочернего процесса.

Используемая поверхность:

| Метод/событие | Назначение |
|---|---|
| `initialize` | Согласовать клиент и сервер. |
| `account/read` | Проверить авторизацию и plan. |
| `account/login/start` | Начать ChatGPT device-code login. |
| `thread/start` | Создать постоянный контекст Conversation. |
| `thread/resume` | Возобновить сохранённый thread. |
| `turn/start` | Запустить Run; для ambient потребовать структурированное решение через `outputSchema`. |
| `turn/steer` | Передать указание в активный turn. |
| `turn/interrupt` | Реализовать `/cancel`. |
| `item/agentMessage/delta` | Стримить ответ. |
| `item/completed` | Зафиксировать окончательный текст agent message. |
| `error` | Сохранить ошибку активного Run. |
| `turn/completed` | Закрыть Run и сохранить результат. |
| `account/updated`, `account/login/completed` | Обновить локальный account status. |

ChatGPT OAuth-токены хранит и обновляет сам Codex в выделенном
`$CODEX_HOME`. API key Summate не требует.

Перед каждым Run Summate создаёт запись `running` и атомарно помечает выбранные
pending inputs как `consumed`, а затем вызывает `account/read`. Если account не
авторизован, Run становится `failed`, но исходный input автоматически в очередь
не возвращается — после входа его нужно отправить повторно. Direct editor Run
просит выполнить `/login`, direct participant Run сообщает о недоступности, а
ambient Run завершается без сообщения в группу.

Для входа отправьте боту `/login` в **личном чате**. Summate не показывает
device code в группе. Команда доступна только администратору. После подтверждения
проверьте `/status`. Все Project owners используют этот общий account и не
выполняют отдельный login.

Официальные источники:

- [Codex App Server](https://developers.openai.com/codex/app-server);
- [Codex CLI](https://developers.openai.com/codex/cli).

## 8. Sandbox и полномочия

Клиент включает experimental App Server API и при `thread/start` или
`thread/resume` выбирает один из двух именованных профилей. Editor thread получает
`summate-project`, в который входят:

- `approvalPolicy = never`;
- `runtimeWorkspaceRoots`, ограниченный conversation worktree;
- `filesystem.:minimal = read` для необходимых системных путей;
- read всего текущего worktree и write только текущего Workspace внутри него;
- `.git`-указатель worktree доступен на чтение, а project-scoped общий Git
  directory — на запись, чтобы owner мог выполнять `git add`, commit, rebase и
  push без доступа к metadata других репозиториев;
- временные файлы editor создаются в `.summate-runtime/tmp` текущего worktree,
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

Read-only Q&A thread получает `summate-project-readonly`: Workspace доступен
только на чтение, network, web search, Browser и Computer Use выключены, а
`.summate-runtime`, `.env`, `.envrc`, `.ssh`, Git/package/cloud credentials,
private keys, certificates и symlinks перед каждым guest run рекурсивно
обнаруживаются host-процессом и закрываются точными deny-путями без ограничения
глубины. Его prompt дополнительно
запрещает builds, tests, servers, package managers, scripts и любые команды с
побочными эффектами. Этот prompt управляет поведением, а именованный permission
profile и `approvalPolicy = never` являются технической границей, которая не даёт
записать изменения или запросить расширение прав.

`turn/start` повторяет `runtimeWorkspaceRoots` и наследует профиль thread. Поля
legacy `sandbox`/`sandboxPolicy` вместе с именованным профилем не передаются.

У Summate нет Telegram-интерфейса подтверждений. Если управляемая политика всё же
присылает command/file approval request, клиент отвечает `decline`; permission
request получает пустой набор permissions, а legacy approvals — явный отказ.
Любой другой server-initiated request получает ошибку `-32601`.

App Server запускается с минимальным allowlist переменных окружения, а shell
получает отдельную ещё более узкую политику. Форма именованного permission profile
сверена с официальной документацией Codex App Server и реальным установленным
сервером.

`CODEX_HOME` должен быть выделен только Summate и использоваться для auth/state.
Runtime откажется запускаться, если его `config.toml` содержит MCP servers или
hooks. `deploy/activate.sh` при каждом развёртывании обновляет системные Codex
requirements из [deploy/codex-requirements.toml](deploy/codex-requirements.toml).

Дополнительные границы:

- `TELEGRAM_OWNER_ID` идентифицирует администратора;
- вне привязанного group topic сообщения принимаются только от администратора или
  owner существующего Project;
- owner может увидеть, привязать и выполнять команды только в своём Project;
- остальные участники привязанного group topic могут отправлять только обычные
  Q&A-сообщения; все slash-команды блокируются;
- direct mention/reply получает приоритетный read-only ответ, остальные сообщения
  проходят rate-limited ambient batch и могут не породить ответ;
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
[projects.summate]
self_change = true
```

Флаг лишь сообщает контексту, что Workspace является телом Summate. Отдельного
механизма автоматического самоизменения он не включает. Изменять код разрешено
только по прямой команде администратора.

`self_change` не является единственным authorization gate. Статический проект
Summate принадлежит администратору, а значение флага попадает в
`.summate-runtime/CONTEXT.md`; прямой запрос администратора дополнительно
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

## 10. Telegram-команды

| Команда | Поведение |
|---|---|
| `/start`, `/help` | Подробная Markdown-справка с назначением команд и примерами; администратор также видит свой блок команд. |
| `/login` | Device-code login; только администратор в личном чате. |
| `/project_create <project> <owner_id> <repo>` | Создать пустой управляемый Git Project; только администратор в личном чате. |
| `/project_clone <project> <owner_id> <repo> <git_url>` | Клонировать управляемый Git Project; только администратор в личном чате. |
| `/projects` | Список доступных отправителю Project и Workspace. |
| `/bind <project> [workspace]` | Привязать текущий topic. |
| `/status` | Account, plan, binding, active/pending. |
| `/steer <текст>` | Направить текст в текущий Codex turn. |
| `/cancel` | Прервать активный turn topic. |
| `/new` | Начать новый Codex thread в topic. |
| `/remember <факт>` | Добавить факт в Project memory. |
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
$SUMMATE_DATA_DIR/
├── config.toml                    # default SUMMATE_CONFIG
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
└── worktrees/                     # default SUMMATE_WORKTREE_ROOT
    └── <conversation-id>/
```

`SUMMATE_CONFIG`, `CODEX_HOME` и `SUMMATE_WORKTREE_ROOT` могут указывать за
пределы data dir. Единственный жёстко расположенный внутри data dir файл базы —
`state.sqlite3`; identity и project memory также всегда строятся от
`SUMMATE_DATA_DIR`.

SQLite хранит:

- binding `chat_id/topic_id → project/workspace`;
- editor и read-only Codex thread id;
- активный turn и Telegram stream message id;
- pending steer/follow-up с `access_mode`, `response_mode` и Telegram user id;
- историю Run: access/response mode, prompt, response, status, error и timestamps;
- управляемые Projects, Workspaces и Telegram owner id;
- последний подтверждённый Telegram update offset.

Основные таблицы:

| Таблица | Содержимое |
|---|---|
| `conversations` | Binding, editor/read-only threads, active turn, stream message и worktree path. |
| `pending_inputs` | Очередь, access/response mode, Telegram user id и состояние обработки. |
| `runs` | Access/response mode, prompt, response, status, error и время выполнения. |
| `runtime_state` | Сейчас только Telegram update offset. |
| `managed_projects` | Динамический Project, его owner и default Workspace. |
| `managed_workspaces` | Абсолютные пути управляемых repositories. |

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
| `agent.participant_batch_sec` | Окно агрегации ambient-сообщений. | 20 |
| `agent.participant_rate_limit_messages` | Сообщений одного участника на окно. | 12 |
| `agent.participant_rate_limit_window_sec` | Длина rate-limit окна. | 60 |
| `agent.network_access` | Сеть внутри Codex sandbox. | true |
| `health.port` | Порт health server. | 8765 |
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
rate-limit window — 10–3600 секунд, health port — 1–65535.

### 12.2. Environment

Секреты и системные пути находятся в
[summate.env.example](summate.env.example):

| Переменная | Назначение |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Обязательный BotFather token. |
| `TELEGRAM_OWNER_ID` | Обязательный numeric user id администратора. |
| `SUMMATE_DATA_DIR` | Корень durable state. |
| `SUMMATE_CONFIG` | Путь к TOML. |
| `SUMMATE_WORKTREE_ROOT` | Каталог conversation worktrees. |
| `CODEX_HOME` | Выделенное состояние/auth Codex. |
| `CODEX_BIN` | Путь или executable name команды `codex`. |
| `NODE_ENV` | Режим Node.js; в production выставляется `production`. |

Значения по умолчанию: `SUMMATE_DATA_DIR=~/Summate/data`, config —
`<data>/config.toml`, worktrees — `<data>/worktrees`, `CODEX_HOME=<data>/codex`,
`CODEX_BIN=codex`. `CODEX_BIN` также можно задать как `agent.codex_binary` в TOML,
но environment имеет приоритет. `TELEGRAM_OWNER_ID` должен быть положительным
безопасным JavaScript integer. Все управляемые repositories создаются внутри
`<data>/repositories`; отдельная переменная пути намеренно не предусмотрена.
`NODE_ENV` самим runtime не читается.

Не используйте общий пользовательский `~/.codex` как `CODEX_HOME`: Summate
ожидает отдельный auth-only каталог. Для ручной установки обязательно установите
[deploy/codex-requirements.toml](deploy/codex-requirements.toml) в
`/etc/codex/requirements.toml`; `cloud-init` и `deploy/activate.sh` делают это
автоматически.

Для unit-файла из примера EnvironmentFile должен принадлежать `root:summate` и
иметь mode `0640`; `config.toml` принадлежит пользователю `summate` и имеет mode
`0600`.

## 13. Развёртывание на VPS

### 13.1. Системные требования

- Linux с systemd;
- Node.js 24+ и npm;
- Git;
- curl;
- Codex CLI с командой `app-server`;
- исходные репозитории на локальном диске VPS;
- исходящий HTTPS к Telegram и OpenAI.

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

- устанавливает Git, curl, rsync, SQLite CLI, UFW и unattended upgrades;
- устанавливает зафиксированный Node.js 24 LTS из официального binary archive и
  проверяет SHA-256 по официальному `SHASUMS256.txt`;
- устанавливает актуальный Codex CLI официальным standalone installer;
- создаёт непривилегированного пользователя `summate` и каталоги данных;
- создаёт 4 GiB swap со `swappiness=10` для VPS с 4 GiB RAM;
- оставляет снаружи только SSH 22/tcp, запрещает password login и сохраняет
  root login только по SSH-ключу;
- включает ежедневные security updates;
- не запускает Summate до загрузки исходников и добавления Telegram credentials.

Cloud-init user-data сохраняется в metadata Hetzner и локально на VPS. Поэтому в
нём намеренно нет Telegram token, OpenAI credentials, приватного Git deploy key
или содержимого репозитория.

Репозиторий приватный и не клонируется из cloud-init. Дождитесь окончания
bootstrap и перенесите текущий checkout вместе с `.git`:

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
```

`.git` нужен для постоянных worktree, веток и self-change workflow; не заменяйте
эту передачу архивом только рабочих файлов. После загрузки войдите на VPS,
заполните два секрета и активируйте инсталляцию:

```bash
ssh -i ~/.ssh/summing-deploy root@"${summate_server}"
nano /etc/summate/summate.env
# TELEGRAM_BOT_TOKEN=...
# TELEGRAM_OWNER_ID=...
/opt/summate/deploy/activate.sh
```

[deploy/activate.sh](deploy/activate.sh) создаёт production config при его
отсутствии, проверяет credentials, выполняет `npm ci`, lint, тесты, production
build и `npm prune --omit=dev`, устанавливает unit, включает сервис и ждёт
успешный loopback health check. Существующие `config.toml` и environment file он
не перезаписывает, поэтому сценарий можно безопасно повторить после обновления
кода.

После запуска отправьте боту `/login`, завершите ChatGPT device-code flow, затем
в личном чате создайте управляемый Project через `/project_create` или
`/project_clone`. Назначенный owner должен отправить боту `/start`, после чего
можно создать forum group/topics и выполнить `/bind`.

### 13.3. Ручная подготовка пользователя и каталогов

```bash
sudo useradd --system --create-home --home-dir /var/lib/summate summate
sudo install -d -o summate -g summate -m 0700 /var/lib/summate/data
sudo install -d -o root -g summate -m 0750 /etc/summate
```

Расположите код, например, в `/opt/summate`, а статические проектные репозитории —
в `/srv/projects`. Пользователь `summate` должен иметь права на Workspace из
конфига. Управляемые Telegram-repositories runtime создаёт сам внутри data dir.

### 13.4. Node.js и сборка

```bash
cd /opt/summate
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
sudo cp deploy/config.production.toml /var/lib/summate/data/config.toml
sudo cp summate.env.example /etc/summate/summate.env
sudo chown summate:summate /var/lib/summate/data/config.toml
sudo chown root:summate /etc/summate/summate.env
sudo chmod 0600 /var/lib/summate/data/config.toml
sudo chmod 0640 /etc/summate/summate.env
```

Отредактируйте token, Telegram ID администратора, `CODEX_BIN` и пути статических
Workspace.

### 13.6. Systemd

Скопируйте [deploy/summate.service](deploy/summate.service):

```bash
sudo cp deploy/summate.service /etc/systemd/system/summate.service
sudo systemctl daemon-reload
sudo systemctl enable --now summate
```

Unit запускает `/usr/local/bin/node --enable-source-maps`, читает
`/etc/summate/summate.env`, работает от `summate:summate` с `UMask=0077` и
останавливает всю process group. Cloud-init устанавливает Node именно в этот
путь. При другом способе установки исправьте `ExecStart` до первого запуска.

Проверка:

```bash
systemctl status summate
journalctl -u summate -f
curl --fail http://127.0.0.1:8765/health
```

После первого запуска откройте личный чат с ботом, отправьте `/login`, завершите
ChatGPT device-code flow, создайте Project через `/project_create` или
`/project_clone`, затем создайте forum group/topics и выполните `/bind`.

## 14. Операционное управление

В проекте нет собственного CLI. Операционные команды стандартные:

```bash
sudo systemctl start summate
sudo systemctl stop summate
sudo systemctl restart summate
sudo systemctl status summate
journalctl -u summate --since today
journalctl -u summate -f
curl --fail --silent http://127.0.0.1:8765/health
curl --fail --silent http://127.0.0.1:8765/state
```

`/health` и `/state` сейчас являются алиасами и возвращают один компактный JSON:

```json
{
  "ok": true,
  "version": "8.3.0",
  "codex_running": true,
  "auth": "chatgpt",
  "plan": "plus",
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
- `SUMMATE_WORKTREE_ROOT`, если нужно сохранить незакоммиченные изменения;
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
sudo systemctl stop summate
# сделать snapshot /var/lib/summate/data и локальных Git-репозиториев
sudo systemctl start summate
```

Для online backup SQLite следует использовать механизм SQLite backup, а не
копировать только основной файл без WAL/SHM.

### 15.3. Восстановление

1. восстановить репозитории и Git refs по прежним абсолютным путям;
2. восстановить data dir и permissions;
3. проверить `config.toml` и `CODEX_BIN`;
4. запустить сервис;
5. проверить journal, health и `/status`;
6. если Codex thread больше не возобновляется, Summate автоматически создаст
   новый и сохранит Project memory/worktree.

## 16. Диагностика

### Сервис постоянно рестартует

```bash
systemctl status summate
journalctl -u summate -n 200 --no-pager
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
`$SUMMATE_DATA_DIR/repositories/<project>/<repo>` остался после прерванной
операции, runtime намеренно не удаляет его и просит администратора сначала
проверить содержимое. Для private clone проверьте non-interactive credentials
пользователя `summate`; `GIT_TERMINAL_PROMPT=0` запрещает зависнуть на запросе
пароля.

### Обычное сообщение «пропало» во время ответа

Для Project owner оно поставлено без acknowledgement в direct follow-up queue;
после текущего Run такие сообщения объединяются в следующий turn. Для обычного
участника отсутствие ответа может быть штатным: ambient input ждёт batch-window,
а затем модель может признать его несущественным. Для гарантированного Q&A нужно
упомянуть `@username_бота` или ответить на сообщение бота. Если не срабатывает и
это, проверьте Privacy Mode/права администратора бота и rate limit. `/status`
показывает `pending` текущего topic владельцу и глобальный счётчик администратору.

### Steer не изменил текущий ответ

Turn мог завершиться до доставки. Запись не удаляется и будет выполнена как
follow-up. Для явного поведения используйте `/steer` или reply на текущий stream.

### Git worktree не создаётся

Проверьте:

```bash
git -C /path/to/repo status
git -C /path/to/repo worktree list
git -C /path/to/repo branch --list 'summate/*'
```

Целевой каталог не должен содержать посторонние файлы. Summate не удаляет его
автоматически. Если journal сообщает, что worktree принадлежит другому
репозиторию, сравните исходный repo и `$SUMMATE_WORKTREE_ROOT/tg-<hash>` через
`git worktree list`; дальнейшая очистка — явная операторская операция.

### Panic stop

После `/panic` состояние ожидаемо:

```bash
systemctl status summate
```

Вернуть сервис может только администратор:

```bash
sudo systemctl start summate
```

## 17. Разработка и проверка

Структура репозитория:

```text
src/
├── index.ts                # signals и process entry
├── config.ts               # TOML/env validation
├── runtime.ts              # Telegram ↔ Conversation ↔ Codex orchestration
├── async-primitives.ts     # semaphore и deferred completion
├── telegram-api.ts         # минимальный Bot API client на fetch
├── codex-app-server.ts     # типизированная JSONL/RPC boundary
├── project-catalog.ts      # managed Projects, owners и Git provisioning
├── state-store.ts          # SQLite authority
├── workspace-manager.ts    # memory и Git worktrees
└── health-server.ts        # loopback HTTP

tests/
├── config.test.ts
├── project-catalog.test.ts
├── runtime-access.test.ts
├── state-store.test.ts
├── codex-app-server.test.ts
├── telegram-api.test.ts
└── workspace-manager.test.ts

deploy/
├── cloud-init.yaml         # bootstrap чистого Ubuntu/Hetzner VPS
├── activate.sh             # сборка, установка unit и первый запуск
├── config.production.toml  # минимальный production config для Summate
└── summate.service         # systemd unit
```

Локальные проверки:

```bash
make build
make test
make lint
```

`make test` сначала компилирует TypeScript, затем запускает 14 тестов через
стандартный `node:test`. Они проверяют config, SQLite/restart recovery, Telegram
splitting, project-owner ACL, JSONL-протокол и формы Codex v2, создание и clone
управляемых repositories, локальный Git worktree и merge project memory. Для
suite не нужен Telegram token, OpenAI account или сеть; полноценного
Telegram/OpenAI end-to-end теста в репозитории нет.

При изменении протокола Codex необходимо сверяться с актуальной официальной
документацией. `npm run codex:types` генерирует в игнорируемый каталог
`.codex-protocol/` точные TypeScript bindings установленной версии CLI для такой
сверки. Runtime намеренно держит только используемый узкий контракт, а не 700+
сгенерированных типов. При изменении state schema миграция должна сохранять
существующие Conversation, pending input и run history.

## 18. Границы текущей версии

Это намеренные ограничения, а не скрытые обещания:

- один Telegram administrator id и один owner id на управляемый Project;
- один общий ChatGPT/Codex account администратора;
- текст и caption принимаются; само вложение в Codex не передаётся;
- один бот и один SQLite;
- нет multi-host coordination;
- нет автоматического merge/push;
- нет смены owner, удаления Project или добавления второго repository через Telegram;
- нет публичного dashboard;
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
