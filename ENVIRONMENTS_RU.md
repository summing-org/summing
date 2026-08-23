# Энвы проектов в SUMMING

## Контракт репозитория

Код проекта получает конфигурацию через обычные environment variables. Для
локальной разработки репозиторий может использовать `.env`, а в Git следует
коммитить только `.env.example`. Реальные `.env` и `.env.*` SUMMING не включает
в дерево Viewer, Git snapshots или Codex workspace.

На сервере единственный источник значений — вкладка **Энвы** в Project Viewer.
Это обычный dotenv-документ на пару `project + workspace`, например:

```dotenv
NODE_ENV=production
API_URL=https://api.example.com
API_TOKEN=replace-me
```

Поддерживаются комментарии, пустые строки, `export NAME=value`, одинарные и
двойные кавычки. Multiline assignments не поддерживаются. Имена должны
соответствовать `A-Za-z_`/`A-Za-z0-9_`, а дубли запрещены.

Runner владеет `PATH`, `HOME`, `HOSTNAME`, `NODE_OPTIONS`, `DOCKER_HOST`,
`CONFIG_PATH`, `HISTORY_PATH`, `DRY_RUN`, `PUBLISH_IMMEDIATELY`,
`DRY_RUN_ARTIFACT_DIR`, всеми `SUMMING_*` и `LD_*`; редактор отклоняет попытку
задать их.

## Хранение и версии

Project Viewer возвращает plaintext только системному администратору
(`TELEGRAM_OWNER_ID` или локальный admin token) либо любому назначенному owner
конкретного Project. Owner проходит тот же Project ACL и не может запросить
environment чужой Conversation. Сохранение использует optimistic locking: если
документ изменился в другой вкладке, нужно перезагрузить актуальную версию.

Runner хранит каждый документ одним AES-256-GCM envelope. AAD связывает
ciphertext с project, workspace, revision и временем обновления. Master key:

```text
/etc/summing-project-runner/environment.key
```

Файл принадлежит `summing-project-runner`, имеет mode `0400` и не входит в release или
backup данных. Для восстановления нужны одновременно environment key и
`/var/lib/summing-project-runner/jobs/environments`; потеря ключа необратима.

На первом compatibility-запуске старый systemd unit ещё не передаёт путь к
ключу. В этом единственном случае runner создаёт тот же ключ как приватный
`/var/lib/summing-project-runner/environment.key`. Финализатор копирует его без
перегенерации в `/etc/summing-project-runner/environment.key` до установки нового unit,
проверяет совпадение и удаляет временную state-копию; зашифрованные документы
поэтому остаются читаемыми после cutover, а ключ не попадает в data backup.

Шифрование защищает disk/backup от случайного чтения, но не является границей
от скомпрометированного runner: перед запуском runner обязан раскрыть значения.

## Запуск

При создании `validate`, `dry-run` или `run` runner:

1. фиксирует текущую env revision в зашифрованном job snapshot;
2. перед стартом создаёт временный файл `0600` под
   `/run/summing-project-runner/environments`;
3. передаёт его Docker через `--env-file`;
4. удаляет plaintext в `finally`, очищает encrypted job snapshot после job;
5. редактирует совпадающие значения в логах и известных dry-run artifacts.

`build` не получает энвы, чтобы секреты не попадали в image layers. `validate`
всегда запускается с `--network none`. Для остальных действий сеть по умолчанию
тоже выключена и включается только операторским `"network": true` в runner
project config.

## Переход с Connections

Новый runtime не читает `.summing/integrations.json`, provider registry,
gateway/lease/raw grants или Secret Broker после завершённого cutover. Переход
существующего production host выполняется автоматически и состоит из двух фаз.

При первом переключении release активный deploy worker ещё относится к прежней
версии и не умеет запускать hook из будущего release до смены symlink. Поэтому
runner открывает локальный socket в состоянии `not ready`, а основной процесс
`summing` (владелец managed repositories) запускает migration coordinator после
собственного health startup:

1. Оба процесса независимо обнаруживают legacy `envPath` и pinned schedule.
   Только `summing` читает `.summing/integrations.json` и source archive строго
   из закреплённого Git SHA: runner не получает доступа к repository tree.
2. Runner создаёт приватный bootstrap key в своём writable state directory и
   принимает pinned manifest через существующий group-local Unix socket.
3. Runner через старый runtime socket запрашивает одну lease для всех raw API-key
   Connections, объединяет полученные значения с несекретным static env и сразу
   сохраняет один AES-256-GCM document. Runner-owned variables отбрасываются;
   значения не попадают в marker или log, lease освобождается.
4. Только после успешного импорта runner отвечает на health. Ошибка импорта не
   даёт ему стать ready, и legacy deploy worker возвращает предыдущий release.
5. Coordinator передаёт runner один pinned archive, последовательно запускает
   Validate и Dry run на одной code/env revision, а runner самостоятельно
   проверяет completed job metadata и записывает verification marker. При ошибке
   broker и Caddy не меняются, а coordinator повторяет проверку.

Следующий проход deploy timer уже использует новый `summing-deploy` и запускает
root-only `deploy/project-environment-cutover`. Финализатор повторно сверяет
project/workspace, pinned Git SHA и текущую encrypted env revision с verification
marker. Только после этого он:

1. переносит тот же bootstrap key в `/etc/summing-project-runner/environment.key`;
2. заменяет legacy `envPath` на `environmentBootstrap`, устанавливает новый
   runner unit и проверяет его health;
3. удаляет только точный Caddy block `/connections* -> 127.0.0.1:8767`;
4. последним действием выполняет
   `systemctl disable --now summing-secrets.service`.

Если verification ещё идёт, deploy state будет `failed`, но установленный
release, Connections route и broker продолжат работать; тот же SHA проверяется
снова на следующем timer tick. Изменение энвов после проверки делает marker
устаревшим и требует новых Validate/Dry run.

Cutover не удаляет legacy unit, `/var/lib/summing-secrets`, vault или его master
key. До изменения файлов он сохраняет прежние runner config, unit и Caddyfile в
`/var/lib/summing-project-runner/jobs/migrations/connections-to-environment/<project>--<workspace>/`.
Ошибка внутри финализатора восстанавливает их и снова включает broker. Эти
данные нужно сохранять до окончания rollback window; для ручного возврата
сначала восстановите сохранённые config/unit/Caddyfile и
`summing-secrets.service`, а затем переключайте application release.

Режимы gateway/lease и OAuth намеренно не конвертируются автоматически: без
однозначного dotenv-представления startup останавливается до cutover. Raw API-key
Connections поддерживает этот путь, но Project всегда выбирается явно через
`SUMMING_ENV_MIGRATION_PROJECT`; имя внешнего проекта не встроено в SUMMING.
