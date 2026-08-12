#!/usr/bin/env bash
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
  printf '%s\n' 'Run this script as root.' >&2
  exit 2
fi

repo_dir=/opt/summate
data_dir=/var/lib/summate/data
env_file=/etc/summate/summate.env
config_file="${data_dir}/config.toml"

if [ ! -f "${repo_dir}/package.json" ]; then
  printf 'Summate source is missing from %s.\n' "${repo_dir}" >&2
  exit 2
fi
if ! id summate >/dev/null 2>&1; then
  printf '%s\n' 'The summate user is missing; run deploy/cloud-init.yaml first.' >&2
  exit 2
fi
if [ ! -x /usr/local/bin/node ] || [ ! -x /usr/local/bin/codex ]; then
  printf '%s\n' 'Node.js or Codex CLI is missing; run cloud-init bootstrap first.' >&2
  exit 2
fi

install -d -o summate -g summate -m 0700 "${data_dir}"
install -d -o summate -g summate -m 0700 "${data_dir}/codex"
install -d -o summate -g summate -m 0700 "${data_dir}/worktrees"
install -d -o root -g summate -m 0750 /etc/summate
install -d -o root -g root -m 0755 /etc/codex
install -o root -g root -m 0644 \
  "${repo_dir}/deploy/codex-requirements.toml" \
  /etc/codex/requirements.toml
if [ ! -f "${config_file}" ]; then
  install -o summate -g summate -m 0600 \
    "${repo_dir}/deploy/config.production.toml" \
    "${config_file}"
fi
if [ ! -f "${env_file}" ]; then
  install -o root -g summate -m 0640 \
    "${repo_dir}/summate.env.example" \
    "${env_file}"
fi
chown summate:summate "${config_file}"
chmod 0600 "${config_file}"
chown root:summate "${env_file}"
chmod 0640 "${env_file}"

telegram_token="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "${env_file}" | tail -n 1)"
telegram_owner="$(sed -n 's/^TELEGRAM_OWNER_ID=//p' "${env_file}" | tail -n 1)"
if [ -z "${telegram_token}" ] || [ "${telegram_token}" = replace-me ]; then
  printf 'Set TELEGRAM_BOT_TOKEN in %s before activation.\n' "${env_file}" >&2
  exit 2
fi
case "${telegram_owner}" in
  ''|*[!0-9]*)
    printf 'Set numeric TELEGRAM_OWNER_ID in %s before activation.\n' "${env_file}" >&2
    exit 2
    ;;
esac
if [ "${telegram_owner}" -le 0 ]; then
  printf 'TELEGRAM_OWNER_ID must be positive in %s.\n' "${env_file}" >&2
  exit 2
fi

chown -R summate:summate "${repo_dir}"
sudo -u summate \
  env HOME=/var/lib/summate PATH=/usr/local/bin:/usr/bin:/bin \
  bash -c \
  'cd /opt/summate && npm ci && npm run lint && npm test && npm prune --omit=dev'

install -o root -g root -m 0644 \
  "${repo_dir}/deploy/summate.service" \
  /etc/systemd/system/summate.service
systemctl daemon-reload
systemctl enable summate
if ! systemctl restart summate; then
  systemctl status summate --no-pager || true
  journalctl -u summate -n 100 --no-pager || true
  printf '%s\n' 'Summate failed during systemd startup.' >&2
  exit 1
fi

for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:8765/health >/dev/null; then
    printf '%s\n' 'Summate is active and the local health check passes.'
    exit 0
  fi
  if ! systemctl is-active --quiet summate; then
    break
  fi
  sleep 1
done

systemctl status summate --no-pager || true
journalctl -u summate -n 100 --no-pager || true
printf '%s\n' 'Summate did not become healthy.' >&2
exit 1
