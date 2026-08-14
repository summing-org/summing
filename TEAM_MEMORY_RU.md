# Team Space memory

Team Space — долговременная область понимания команды, независимая от Project и
конкретного транспорта. Подключение источника создаёт Team Space немедленно;
привязка Project отдельно разрешает работу с кодом, но не определяет, может ли
SUMMING слушать команду.

## Границы понятий

```text
Team Space
├── Sources                 Telegram chat/topic, Slack channel/thread, WhatsApp chat
├── People                  личности внутри Space
│   └── Identities          provider + external user id; автоматически не объединяются
├── Event journal           наблюдаемое доказательство
├── Knowledge               выводы со ссылками на evidence
├── Interventions           что SUMMING сказал сам и почему
└── Linked Projects         отдельно выданные полномочия на код
```

- Source admission даёт право принимать и хранить доступные источнику события.
- Team Space memory даёт контекст, но не agency.
- Project binding даёт только предусмотренные Project-полномочия.
- Rate limit и решение «отвечать или молчать» применяются после durable ingest,
  поэтому тишина SUMMING не означает потерю командной истории.
- История до подключения не придумывается и не появляется автоматически. Она
  может быть добавлена только отдельным backfill/import с явным provenance.

## Telegram ingress

Bot API запрашивается для:

- новых и отредактированных сообщений;
- channel posts;
- индивидуальных и агрегированных reactions;
- статуса самого бота и участников чата.

Telegram не обязан отдавать историю до приглашения и не предоставляет каждому
боту все возможные события. Team Space фиксирует всё, что реально получил
адаптер, но не заявляет о полноте недоступной истории.

Первое membership-событие или сообщение создаёт:

1. один `team_spaces` для Telegram chat;
2. отдельный `team_sources` для каждого topic;
3. `team_people` и provider identity без догадок о совпадении с человеком в
   другом транспорте;
4. append-only `team_events` с transport ids, reply relationship, временем,
   текстом и метаданными вложений.

Повторная доставка одного provider event идемпотентна. Edit сохраняется новым
событием и переводит выводы, основанные на исходной версии, в `needs-review`.
Удаление или erasure очищает содержимое evidence, но сохраняет минимальный
tombstone, чтобы зависимые выводы не продолжали выглядеть доказанными.

## Evidence и knowledge

`team_events` — authority наблюдения. Оно отвечает только на вопрос «что было
получено». `team_knowledge` — authority производного понимания:

- `episode` — последовательность событий;
- `fact` — явно подтверждённый факт;
- `decision` — принятое или отменённое решение;
- `task` — обязательство или работа;
- `question` — открытая неопределённость;
- `risk` — риск или blocker;
- `term` — общий язык команды;
- `person` — роль, экспертиза или явно указанное предпочтение;
- `hypothesis` — возможный мотив, намерение или другое неявное объяснение.

Каждый knowledge item содержит:

- confidence и status;
- temporal `valid_from` / `valid_to`;
- visibility `space`, `source` или `person`;
- один или несколько `evidence_event_ids`;
- явные supersession links для исправления старых выводов.

Наблюдаемая фраза может стать фактом о том, что человек сказал. Причина, по
которой он это сказал, всегда остаётся `hypothesis`; чувствительные свойства не
выводятся. Visibility проверяется при чтении, а не доверяется формулировке LLM.

## Conversation Understanding Loop и model egress

Локальный event journal не означает автоматического разрешения отправлять всю
командную переписку модели. Фоновое осмысление требует отдельного явного
operator consent на передачу текста, sender identity, message/reply ids,
timestamps, attachment metadata и локально полученных транскрипций в Codex App
Server администратора.

Согласие материализуется настройкой `team_memory.model_egress_enabled = true`; по
умолчанию она выключена. До первого batch runtime публикует отдельный egress notice
с точным составом передаваемых данных. До такого согласия события сохраняются
локально, но Conversation Understanding Loop не запускается. Прямое упоминание
продолжает прежний ограниченный projectless Q&A flow: это явный запрос пользователя,
а не фоновый egress.

### Один проход понимания, два результата

У SUMMING нет отдельного Project ambient-turn «нужно ли ответить?» и отдельного
Team Space turn «что запомнить?». Один source-local model pass сначала строит общую
интерпретацию эпизода, а затем из неё одновременно выводит долговременную память и
решение об интервенции:

```text
provider update
      │
      ▼
credential interception → durable Event Journal
      │
      ▼
source-local adaptive batch
      │
      ▼
Conversation Understanding Loop          один model turn
      ├── Conversation Episode            кто, кому, о чём и зачем
      ├── Team Space summary delta         текущее общее понимание
      ├── knowledge candidates             fact/decision/task/risk/…
      └── intervention decision            silent | reply
             │
             └── Telegram reply только после deterministic gates
```

Это принципиальный инвариант: память и реплика не могут основываться на двух
независимых прочтениях одного разговора. `silent` — полноценный успешный результат;
он обновляет episode/knowledge, но ничего не отправляет в Telegram.

### Граница Conversation Episode

Batch всегда принадлежит ровно одному `team_source`: одному Telegram topic, Slack
thread или будущему эквиваленту. События двух топиков одного Team Space не смешиваются
в один episode. При этом loop видит уже подтверждённые знания всего Team Space и
bounded `reply_target` snapshot, поэтому способен связать новую реплику с более ранним
сообщением того же source.

Планировщик использует три совместных триггера:

1. `team_memory.understanding_quiet_sec` — trailing debounce; каждое новое событие
   source перезапускает окно тишины, по умолчанию 20 секунд;
2. `team_memory.understanding_max_wait_sec` — hard deadline от первого ожидающего
   события, по умолчанию 90 секунд, поэтому непрерывный разговор не откладывает
   понимание бесконечно;
3. `team_memory.understanding_max_events` — немедленный запуск при достижении размера
   batch, по умолчанию 40 событий.

Следовательно, это не polling «один вызов каждые 20 секунд». Один короткий burst
обычно создаёт один model turn после паузы; длинный непрерывный разговор режется hard
deadline или event cap. Одновременно выполняется один background loop; остальные
Sources сохраняют evidence и ждут своей очереди. После ошибки batch остаётся pending,
а retry получает экспоненциальный backoff до одного часа.

С точки зрения model usage один успешно обработанный batch равен одному Codex turn —
не одному turn на сообщение и не двум turn для attention/memory. Runtime не рассылает
один episode одновременно в Codex, OpenAI API, Anthropic и Gemini: background reasoning
использует одну настроенную модель через Codex App Server. Direct mention/reply создаёт
дополнительный немедленный turn, потому что это новый явный запрос пользователя.
Транскрипция voice/audio является отдельным вызовом выбранного transcription API;
чтение account limits раз в 15 минут — control-plane RPC без model inference.

### Structured contract

Model output состоит из пяти согласованных частей:

- `episode` — `source_id`, тема, synopsis, confidence, полный набор `event_ids` и
  участники с ролями `speaker` / `addressee` / `mentioned`; предполагаемый intent
  всегда имеет собственный confidence;
- `summary` — обновлённое bounded понимание Team Space;
- `knowledge` — новые facts, decisions, tasks, questions, risks, terms, person items
  и hypotheses; episode отдельно добавляет runtime, поэтому модель не дублирует его;
- orientation — готовность впервые представиться команде и самые ценные вопросы;
- `intervention` — `silent` либо `reply` с причиной и target event из текущего batch.

Runtime не доверяет JSON только потому, что его вернула модель. Он проверяет, что
episode покрывает batch целиком и не пересекает Source; участники существуют внутри
Space; evidence ids, visibility и supersession не пересекают границы; confidence и
temporal interval валидны; reply ссылается на реальное provider message текущего
batch. Невалидный output не создаёт ни знания, ни видимость понимания.

### Молчание, orientation и прямые обращения

Для человеческой беседы default — `silent`. Loop не подтверждает, не пересказывает и
не отвечает только потому, что сообщение написал администратор или Project owner.
`reply` допустим для существенной неоднозначности, фактической ошибки, противоречия,
blocker, риска или незакрытого решения, где краткая реплика помогает именно сейчас.

До `team_memory.orientation_event_threshold` SUMMING накапливает понимание молча.
После порога он один раз публикует orientation и главные вопросы. Дальнейший reply
разрешён только после orientation, только к конкретному evidence event и не чаще
`team_memory.intervention_cooldown_sec`. Решение `silent` и причина видны в audit
успешного loop run; `team_interventions` хранит только реально подготовленные к
доставке сообщения.

Явный bot mention, reply боту или команда не ждут background batch: это отдельный
немедленный direct turn с полномочиями конкретного пользователя. Он также остаётся
evidence и позже войдёт в общий episode. Background loop никогда не получает Project
files, editor history, network или agency и не запускает второй Project-aware ambient
turn. Если для помощи нужна проверка репозитория, SUMMING формулирует пробел; человек
явно обращается к боту, и только этот direct turn получает разрешённый Project context.

После включения loop соблюдает следующие технические инварианты:

1. один bounded batch вместо turn на каждое сообщение;
2. read-only ephemeral Codex thread без Project, сети и внешних capabilities;
3. один structured output для episode, knowledge и intervention;
4. deterministic validation до записи knowledge;
5. credentials отбрасываются до journal и до model boundary;
6. ошибка оставляет events pending и не симулирует понимание;
7. intervention создаётся только после warm-up, сохраняется с причиной и имеет
   cooldown.

Старые ключи `team_memory.synthesis_batch_sec` и `team_memory.max_batch_events`
читаются как compatibility aliases для quiet window и event cap. Новые конфиги должны
использовать `understanding_*`; отдельный synthesis scheduler больше не существует.

## Transparency и управление

При admission SUMMING публикует уведомление о durable observation. Доступны:

| Команда | Поведение |
|---|---|
| `/memory`, `/memory_status` | Состояние Team Space и видимые отправителю знания. |
| `/memory_me` | События пользователя и выводы с их evidence. |
| `/memory_forget_me` | Redact собственных событий, удалить связанные выводы, пометить summary для пересборки и остановить будущий ingest. |
| `/memory_resume_me` | Возобновить будущий ingest; удалённое не восстанавливается. |
| `/memory_pause` | Администратор приостанавливает весь Space. |
| `/memory_resume` | Администратор возобновляет Space. |

`team_memory.raw_retention_days` очищает raw text и attachment metadata по
возрасту, включая ещё не синтезированные events. Значение `0` явно означает
бессрочную локальную retention policy. Credentials никогда не становятся Team
Space evidence: security ingress перехватывает их раньше.

## Transport model

Persistence принимает provider-neutral `TeamEventInput`. Telegram — первый
адаптер. Следующие адаптеры должны только:

1. подтвердить admission и аудиторию;
2. нормализовать provider ids, source/thread, person identity, replies, edits,
   reactions, deletions и attachments;
3. честно объявить capability gaps конкретного API;
4. передать event тому же journal;
5. не создавать отдельную Slack/WhatsApp memory authority.

Slack, WhatsApp и будущие источники не должны автоматически объединять людей по
имени, username, телефону или стилю письма. Identity merge — отдельное
подтверждённое событие с аудитом.
