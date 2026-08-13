# SUMMING Connections

## Зачем это нужно

Telegram-чат с ботом не является каналом для передачи секретов. Бот получает
обычные сообщения в открытом виде, а текст затем может попасть в очередь агента,
логи или историю. Поэтому SUMMING перехватывает сообщения и текстовые вложения,
похожие на credentials, пытается удалить исходное Telegram-сообщение и сохраняет
только тип срабатывания. Значение не попадает в Codex или основную state DB.

Правильный путь — `/connections` в Project Viewer. Viewer выдаёт подписанный
Ed25519 ticket на пять минут, привязанный к Telegram user, проекту и точной
декларации integration. Ticket передаётся из Viewer в отдельный Connections UI
через URL fragment, сразу убирается из адресной строки и одноразово расходуется
при сохранении, OAuth start, отзыве или raw-разрешении.

Главный invariant:

> Код проекта не получает долгоживущий credential без явного разрешения
> владельца проекта.

## Три режима

| Режим | Что получает job | Когда использовать |
|---|---|---|
| `gateway` | Короткоживущий capability-token и Unix socket | SUMMING уже знает capability и SDK можно заменить gateway-вызовом |
| `lease` | Временный credential без refresh/root credential | Провайдер умеет выдавать временный доступ; сейчас поддержан OAuth access token |
| `raw` | Исходное значение в env конкретного job | Нужна совместимость со стандартным SDK и владелец принял риск |

Trusted provider registry сообщает Viewer доступные режимы. `gateway`
рекомендуется только тогда, когда реестр содержит каждую запрошенную capability
и связывает её с конкретными HTTP methods/path prefixes. Проектный manifest
может только сузить эту политику. Если gateway нет, OAuth предпочитает `lease`;
для API key остаётся `raw`.

Выбор не переключается автоматически: смена режима обычно требует изменения
кода проекта. Viewer показывает, когда для raw-интеграции уже доступен более
безопасный режим.

## Manifest проекта

Файл `.summing/integrations.json` не содержит значений секретов и коммитится
вместе с кодом. Raw MVP для обычного SDK:

```json
{
  "version": 1,
  "integrations": [
    {
      "id": "transactional-email",
      "provider": "resend",
      "environment": "production",
      "auth": "api_key",
      "mode": "raw",
      "capabilities": ["email.send"],
      "scopes": [],
      "actions": ["dry-run", "run"],
      "secrets": [{ "name": "api_key" }],
      "runtime": [{ "name": "api_key", "env": "RESEND_API_KEY" }]
    }
  ]
}
```

`capabilities` в raw-режиме позволяют показать возможность будущего перехода,
но не дают никаких полномочий сами по себе.

OAuth lease:

```json
{
  "id": "source-control",
  "provider": "github",
  "environment": "production",
  "auth": "oauth2",
  "mode": "lease",
  "capabilities": [],
  "scopes": ["repo"],
  "actions": ["run"],
  "runtime": [{ "name": "access_token", "env": "GITHUB_TOKEN" }]
}
```

Refresh token остаётся в broker. Если access token истёк, broker обновляет его
до запуска job и отдаёт только новый access token и явно перечисленную runtime
metadata.

Gateway:

```json
{
  "id": "transactional-email",
  "provider": "resend",
  "environment": "production",
  "auth": "api_key",
  "mode": "gateway",
  "capabilities": ["email.send"],
  "scopes": [],
  "actions": ["dry-run", "run"],
  "secrets": [{ "name": "api_key" }],
  "gateway": {
    "methods": ["POST"],
    "pathPrefixes": ["/emails"]
  }
}
```

Runner задаёт для него:

```text
SUMMING_TRANSACTIONAL_EMAIL_PRODUCTION_GATEWAY_SOCKET
SUMMING_TRANSACTIONAL_EMAIL_PRODUCTION_GATEWAY_PATH
SUMMING_TRANSACTIONAL_EMAIL_PRODUCTION_GATEWAY_TOKEN
```

Gateway-only job запускается с `--network none`; наружу ходит только broker.
Runner отзывает lease в `finally`, поэтому capability удаляется сразу после job;
TTL остаётся защитой от аварийного завершения runner.

Manifest parser запрещает symlink/файл больше 128 KB, неизвестные режимы,
зарезервированные env (`SUMMING_*`, `PATH`, `NODE_OPTIONS`, `LD_*` и другие),
дублирующиеся env и path traversal.

## Raw-разрешение

При вводе API key в raw-режиме Connections UI отдельно показывает предупреждение
и требует checkbox. Владелец выбирает:

- `once` — grant атомарно расходуется первым broker lease, даже если job позднее
  завершился ошибкой;
- `project` — последующие подходящие job могут получать credential до отзыва.

После расходования `once` ciphertext остаётся зашифрованным, но Viewer снова
блокирует Run. Новый ticket позволяет выдать ещё один grant без повторного ввода
ключа. Revoke удаляет encrypted envelope и все raw grants.

Raw означает реальную границу доверия: код может прочитать env, изменить или
закодировать значение, записать его в смонтированные project data либо отправить
в сеть. Exact-value redaction в логах и известных dry-run artifacts уменьшает
случайные утечки, но не является sandbox от намеренного кода.

## Vault и runtime

Credentials хранятся в отдельной SQLite DB. Для каждой версии создаётся случайный
data-encryption key; payload шифруется AES-256-GCM, а data key отдельно оборачивается
master key. AAD связывает ciphertext с project/integration/environment/provider/auth.
Metadata API возвращает status, scopes, version, fingerprint последних четырёх
символов и grant, но никогда значение.

Broker ведёт metadata-only audit для connect/rotate/revoke, ticket consumption,
raw authorization и job leases. Revoke уничтожает envelope. Master key находится
в отдельном private-файле; его и vault DB нужно резервировать вместе.

Для `raw`/`lease` runner создаёт per-job env-файл с mode `0600` под
`/run/summing-runner/leases` (tmpfs RuntimeDirectory), передаёт только путь через
Docker `--env-file` и удаляет файл в `finally`. Значения не добавляются в Docker
CLI args или job metadata. Gateway socket доступен runner/container, control socket
— только основной службе SUMMING.

Постоянный project env теперь предназначен только для несекретной конфигурации.
Runner fail-closed отклоняет credential-like имена (`*_API_KEY`, `*_TOKEN`,
`*_SECRET`, passwords, private keys и т. п.), чтобы старый `.env` не обходил
grants. Installer не удаляет существующие значения: перед первым запуском после
обновления перенесите их в manifest + Connections, а из static env удалите.

## Trusted provider registry

`/etc/summing-secrets/providers.json` управляется оператором, а не проектом:

```json
{
  "providers": {
    "resend": {
      "apiBaseUrl": "https://api.resend.com",
      "allowedMethods": ["POST"],
      "allowedPathPrefixes": ["/emails"],
      "gatewayCapabilities": {
        "email.send": {
          "allowedMethods": ["POST"],
          "allowedPathPrefixes": ["/emails"]
        }
      },
      "authentication": {
        "type": "bearer",
        "credential": "api_key"
      }
    }
  }
}
```

Endpoints обязаны быть HTTPS без embedded credentials. Redirects gateway и
OAuth token exchange не следуют автоматически. OAuth client secret задаётся
отдельным абсолютным private file, а scopes пересекаются с allowlist registry.

## Production

`deploy/install-project-operations.sh` создаёт отдельного пользователя и unit
`summing-secrets`, master key, Ed25519 ticket keypair, provider registry и три
Unix sockets с разными group ACL. Connections использует тот же HTTPS origin,
что Viewer: Caddy отправляет `/connections*` на loopback port `8767`, остальное —
на Viewer `8766`.

После installer проверьте:

```bash
sudo systemctl restart summing   # выполните в выбранное окно: это прервёт активный Codex turn
sudo systemctl status summing-secrets summing-runner summing
curl --fail --silent https://assist.example.com/connections >/dev/null
sudo journalctl -u summing-secrets -n 100 --no-pager
```

Provider/OAuth additions делаются только в `/etc/summing-secrets`; проект не
может менять trusted registry. Не помещайте master key, ticket private key,
provider client secrets или vault DB в Git.

Текущая реализация lease поддерживает OAuth access-token lease. AWS STS,
database ephemeral users и другие provider-specific leases добавляются как
отдельные trusted adapters; до этого для соответствующего SDK используется
явно разрешённый `raw`.
