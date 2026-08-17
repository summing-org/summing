# Fresh installer SUMMING

Новая production-инсталляция состоит из трёх отдельных фаз:

1. **Provisioning** создаёт чистый Ubuntu 24.04 host, firewall и системное
   окружение. Прикладных секретов в Terraform и cloud-init нет.
2. **Secure bootstrap** передаёт на host проверенный Git bundle и одноразовый
   приватный manifest, формирует конфигурацию, собирает release, запускает
   systemd services и проверяет health endpoint.
3. **Интерактивный onboarding** в owner-only Admin Mini App проводит владельца
   через `/login`, подключение группы, MTProto, согласия и первый backfill.

Installer предназначен только для нового host. Он не удаляет старую базу и не
пытается наложить «чистую» схему на существующие SQLite-файлы. При обнаружении
durable state secure bootstrap завершится отказом. Для настоящего запуска с
чистого листа создаётся новый VPS, а старый остаётся доступен до приёмки.

## 1. Provisioning в Hetzner

Нужны Terraform 1.8+, существующий SSH key в Hetzner и токен с правами на
создание server/firewall. Токен передаётся provider через `HCLOUD_TOKEN` и не
попадает в `tfvars`.

```bash
cd infra/hetzner
cp terraform.tfvars.example terraform.tfvars
# Укажите ssh_key_name и свой ограниченный /32 или /128 CIDR.
export HCLOUD_TOKEN=...
terraform init
terraform plan
terraform apply
terraform output -raw fresh_install_target
```

Terraform включает delete/rebuild protection, backups, Ubuntu 24.04 и firewall:
SSH доступен только из `ssh_source_cidrs`, HTTP/HTTPS — публично. Cloud-init
устанавливает Node 24, Codex CLI, Caddy, systemd prerequisites, UFW, unattended
security updates и создаёт root-only `/etc/summing/provisioned`.

Создайте DNS A/AAAA для домена Mini App на адрес из Terraform output. До
bootstrap можно проверить host так:

```bash
ssh root@SERVER cloud-init status --wait
```

Terraform state содержит инфраструктурные идентификаторы и IP. Держите его в
зашифрованном remote backend либо в защищённом operator-каталоге.

### Уже rebuilt VPS без Cloud Config

Hetzner показывает Cloud Config при создании сервера, но не в обычном UI-flow
rebuild. Такой чистый Ubuntu 24.04 host не нужно удалять ещё раз: передайте
`--provision` в основной installer. Он доставит secret-free
`deploy/provision-host`, проверит `x86_64`, отсутствие старого SUMMING state,
установит тот же системный baseline и только после этого перейдёт к secure
bootstrap.

После rebuild SSH host key закономерно меняется. Installer использует
`StrictHostKeyChecking=accept-new`: он добавит совершенно новый host, но
отклонит изменившийся ключ для уже известного IP. Сначала сверяйте новый ED25519
fingerprint через Hetzner Web Console:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

И только после совпадения удаляйте старую локальную запись:

```bash
ssh-keygen -R SERVER
```

## 2. Одноразовый install manifest

Скопируйте [пример manifest](deploy/fresh-install.example.json) за пределы Git
checkout и заполните:

- Bot API token и Telegram user ID единственного владельца;
- отдельный OpenAI API key;
- HTTPS-домен Mini App и случайный local admin token;
- S3-compatible endpoint, bucket и credentials;
- подтверждение legal gate `telegramTermsReviewed: true` только после реального
  выполнения требований Telegram и фиксации процесса согласий.

Сгенерировать local token и закрыть доступ к manifest:

```bash
openssl rand -hex 32
chmod 0600 /secure/path/fresh-install.json
```

Для приватного Git origin создайте отдельный read-only deploy key. Его private
часть также должна иметь режим `0400` или `0600`; не вставляйте ключ или Git
token в URL.

## 3. Secure bootstrap одной командой

Команду запускают из корня чистого trusted checkout на нужном release commit:

```bash
deploy/install-fresh \
  --target root@SERVER \
  --identity ~/.ssh/summing-deploy \
  --port 22 \
  --secrets /secure/path/fresh-install.json \
  --origin git@github.com:ORG/REPOSITORY.git \
  --source-key /secure/path/summing-readonly-key
```

Для credential-free HTTPS origin `--source-key` не нужен. Перед отправкой
installer:

- отклоняет tracked changes и небезопасные параметры;
- локально валидирует manifest с Node 24 до подключения к серверу;
- создаёт Git bundle ровно из текущего commit и проверяет его;
- ждёт завершения cloud-init;
- копирует inputs в root-only каталог `/run`;
- требует точного совпадения полного SHA на сервере;
- закрепляет переданный origin одновременно в Git и root-only deployment policy;
- удаляет удалённые копии manifest, bundle и deploy key при любом завершении
  root-bootstrap; повторная попытка загружает их заново.

Для уже rebuilt VPS добавьте `--provision` к той же команде. Provisioner
идемпотентен, не принимает application secrets и отказывается работать поверх
непустого `/opt/summing`, systemd unit или SQLite state. Если системные
обновления требуют reboot, installer перезагрузит host, дождётся реального
disconnect/reconnect по тому же identity/port и продолжит автоматически.

Root-bootstrap атомарно создаёт `/etc/summing/summing.env` с режимом `0640` и
`/var/lib/summing/data/config.toml` с режимом `0600`. MTProto master key и ключ
переноса knowledge base генерируются на host. Dependency install, lint и тесты
выполняются отдельным `summing-builder`, который не входит в secret-bearing
группу `summing`; даже lifecycle scripts не могут читать application keys. OTP
и 2FA в эти файлы не входят.

Успешный результат:

```text
SUMMING fresh installation … completed at <commit>.
Continue in the owner-only Admin Mini App onboarding.
```

Повтор того же `installationId + commit` безопасен: незавершённый bootstrap
продолжится, а завершённый сначала проверит health и затем вернёт success.
Другой installation ID или release поверх существующего install-state
отклоняется. Обновления после первой установки выполняет штатный atomic deploy.

## 4. Интерактивный onboarding

1. Владелец открывает личный чат с ботом, отправляет `/start`, затем `/login` и
   завершает device-code flow Codex.
2. Добавляет бота в целевую группу и отправляет сообщение, доступное Bot API.
3. Открывает **Управление → База знаний**. Карточка onboarding показывает живое
   состояние provisioning, secure bootstrap и последующих шагов.
4. Вводит Telegram API ID/hash и телефон технического аккаунта. OTP и 2FA
   проходят через короткоживущий challenge и не сохраняются.
5. Фиксирует согласие каждого предполагаемого автора на `history + future +
   model egress`, включая историческую границу и доказательство.
6. Выбирает группу и готовый MTProto-коннектор, запускает sync.
7. Следит за карточкой либо командой `/sync_status <chat_id>`. Первый этап готов,
   когда collector перешёл в `collected`/`tailing`; media, extraction и vectors
   могут завершаться независимо.

MTProto-сессия остаётся активной для live tail, правок, удалений и восстановления
пропусков. Отвязка группы не разлогинивает общий аккаунт. Полный logout доступен
только отдельным подтверждённым отзывом коннектора без привязанных групп.

## Диагностика и безопасный откат

```bash
ssh root@SERVER systemctl status summing
ssh root@SERVER journalctl -u summing -n 200 --no-pager
ssh root@SERVER curl --fail http://127.0.0.1:8765/health
```

При ошибке до завершения bootstrap исправьте manifest или инфраструктуру и
повторите ту же команду с тем же commit. Не удаляйте root-only
`/var/lib/summing-install/install-state.json` и SQLite-файлы вручную: это обход
защитной границы fresh install.

Для перехода с прежнего production держите старый host и DNS неизменными, пока
новый не прошёл onboarding, контрольный поиск и проверку `/sync_status`.
Переключайте DNS только после приёмки. Удаление старого VPS — отдельное
подтверждённое действие после backup/export и периода наблюдения.
