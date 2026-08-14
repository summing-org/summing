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
(`TELEGRAM_OWNER_ID` или локальный admin token). Сохранение использует
optimistic locking: если документ изменился в другой вкладке, нужно
перезагрузить актуальную версию.

Runner хранит каждый документ одним AES-256-GCM envelope. AAD связывает
ciphertext с project, workspace, revision и временем обновления. Master key:

```text
/etc/summing-runner/environment.key
```

Файл принадлежит `summing-runner`, имеет mode `0400` и не входит в release или
backup данных. Для восстановления нужны одновременно environment key и
`/var/lib/summing-runner/jobs/environments`; потеря ключа необратима.

Шифрование защищает disk/backup от случайного чтения, но не является границей
от скомпрометированного runner: перед запуском runner обязан раскрыть значения.

## Запуск

При создании `validate`, `dry-run` или `run` runner:

1. фиксирует текущую env revision в зашифрованном job snapshot;
2. перед стартом создаёт временный файл `0600` под
   `/run/summing-runner/environments`;
3. передаёт его Docker через `--env-file`;
4. удаляет plaintext в `finally`, очищает encrypted job snapshot после job;
5. редактирует совпадающие значения в логах и известных dry-run artifacts.

`build` не получает энвы, чтобы секреты не попадали в image layers. `validate`
всегда запускается с `--network none`. Для остальных действий сеть по умолчанию
тоже выключена и включается только операторским `"network": true` в runner
project config.

## Переход с Connections

Новый runtime не читает `.summing/integrations.json`, provider registry,
gateway/lease/raw grants или Secret Broker. Installer импортирует существующий
несекретный `/etc/summing-runner/projects/<project>.env` при первом открытии
workspace; runner-owned variables при импорте отбрасываются.

Credentials из прежнего Connections vault автоматически не экспортируются.
Их нужно один раз внести во вкладку **Энвы**, проверить Validate/Dry run и только
после этого отдельно остановить старый `summing-secrets.service`. Installer не
останавливает и не удаляет legacy service/data автоматически, чтобы rollback
оставался возможен.
