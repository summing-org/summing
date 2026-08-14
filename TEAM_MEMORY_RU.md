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

## Model synthesis и egress

Локальный event journal не означает автоматического разрешения отправлять всю
командную переписку модели. Автоматический synthesis требует отдельного явного
operator consent на передачу текста, sender identity, message/reply ids,
timestamps, attachment metadata и локально полученных транскрипций в Codex App
Server администратора.

Согласие материализуется настройкой `team_memory.model_egress_enabled = true`; по
умолчанию она выключена. До первого batch runtime публикует отдельный egress notice
с точным составом передаваемых данных. До такого согласия события сохраняются
локально, но автоматический model synthesis не запускается. Прямое упоминание
продолжает прежний ограниченный projectless Q&A flow: это явный запрос пользователя,
а не фоновый egress.

После включения synthesis соблюдает следующие инварианты:

1. один bounded batch вместо turn на каждое сообщение;
2. read-only ephemeral Codex thread без Project, сети и внешних capabilities;
3. structured output с evidence ids, confidence, visibility и temporal status;
4. deterministic validation до записи knowledge;
5. credentials отбрасываются до journal и до model boundary;
6. ошибка оставляет events pending и не симулирует понимание;
7. intervention создаётся только после warm-up, сохраняется с причиной и имеет
   cooldown.

Runtime собирает до `team_memory.max_batch_events` pending events каждые
`team_memory.synthesis_batch_sec` секунд. Модель получает текущий summary, последние knowledge
items и provider-neutral evidence batch. Результат проходит JSON Schema и повторную
детерминированную проверку: нельзя сослаться на событие вне batch, придумать чужой
source/person visibility, дать пустому выводу provenance или выбрать несуществующее
сообщение для proactive reply. Ошибка оставляет evidence pending для повторной
обработки.

До `team_memory.orientation_event_threshold` SUMMING только накапливает knowledge. После порога
он один раз публикует orientation message и наиболее ценные вопросы. Proactive reply
допустим только после успешной orientation, только reply к конкретному evidence event
и не чаще `team_memory.intervention_cooldown_sec`.

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
