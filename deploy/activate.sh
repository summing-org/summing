#!/usr/bin/env bash
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
  printf '%s\n' 'Run this script as root.' >&2
  exit 2
fi

repo_dir=/opt/summate
current_link=/opt/summate-current
data_dir=/var/lib/summate/data
deploy_state_dir=/var/lib/summate/deploy
env_file=/etc/summate/summate.env
deploy_env_file=/etc/summate/deploy.env
config_file="${data_dir}/config.toml"

if [ ! -f "${repo_dir}/package.json" ]; then
  printf 'Summate source is missing from %s.\n' "${repo_dir}" >&2
  exit 2
fi
if ! id summate >/dev/null 2>&1; then
  printf '%s\n' 'The summate user is missing; run deploy/cloud-init.yaml first.' >&2
  exit 2
fi
if ! id summate-builder >/dev/null 2>&1; then
  useradd \
    --system \
    --create-home \
    --home-dir /var/lib/summate-builder \
    --shell /usr/sbin/nologin \
    summate-builder
fi
if [ ! -x /usr/local/bin/node ] || [ ! -x /usr/local/bin/codex ]; then
  printf '%s\n' 'Node.js or Codex CLI is missing; run cloud-init bootstrap first.' >&2
  exit 2
fi

required_packages=(
  apparmor-profiles
  apparmor-utils
  bubblewrap
  file
  jq
  unzip
)
missing_packages=()
for package in "${required_packages[@]}"; do
  if ! dpkg-query -W -f='${Status}' "${package}" 2>/dev/null | grep -q 'install ok installed'; then
    missing_packages+=("${package}")
  fi
done
if [ "${#missing_packages[@]}" -gt 0 ]; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing_packages[@]}"
fi

bwrap_profile_source=/usr/share/apparmor/extra-profiles/bwrap-userns-restrict
bwrap_profile_target=/etc/apparmor.d/bwrap-userns-restrict
if [ -f "${bwrap_profile_source}" ]; then
  install -o root -g root -m 0644 "${bwrap_profile_source}" "${bwrap_profile_target}"
  apparmor_parser -r "${bwrap_profile_target}"
fi
if ! sudo -u summate bwrap --ro-bind / / --dev /dev --proc /proc /bin/true; then
  printf '%s\n' \
    'bubblewrap user namespaces are unavailable; check the bwrap AppArmor profile.' >&2
  exit 2
fi

install -d -o summate -g summate -m 0700 "${data_dir}"
install -d -o summate -g summate -m 0700 "${data_dir}/codex"
install -d -o summate -g summate -m 0700 "${data_dir}/worktrees"
install -d -o summate -g summate -m 0700 "${deploy_state_dir}"
install -d -o summate-builder -g summate-builder -m 0700 /var/lib/summate-builder
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
if [ ! -f "${deploy_env_file}" ]; then
  install -o root -g root -m 0600 \
    "${repo_dir}/deploy/summate-deploy.env.example" \
    "${deploy_env_file}"
fi
if ! grep -q '^SUMMATE_DEPLOY_REQUEST=' "${env_file}"; then
  printf '%s\n' \
    'SUMMATE_DEPLOY_REQUEST=/var/lib/summate/deploy/request.json' >> "${env_file}"
fi
if ! grep -q '^SUMMATE_DEPLOY_STATE=' "${env_file}"; then
  printf '%s\n' \
    'SUMMATE_DEPLOY_STATE=/var/lib/summate/deploy/state.json' >> "${env_file}"
fi
chown summate:summate "${config_file}"
chmod 0600 "${config_file}"
chown root:summate "${env_file}"
chmod 0640 "${env_file}"
chown root:root "${deploy_env_file}"
chmod 0600 "${deploy_env_file}"

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

if [ -L "${current_link}" ]; then
  :
elif [ -e "${current_link}" ]; then
  printf '%s exists and is not a symlink; inspect it before activation.\n' \
    "${current_link}" >&2
  exit 2
else
  ln -s "${repo_dir}" "${current_link}"
fi

install -o root -g root -m 0644 \
  "${repo_dir}/deploy/summate.service" \
  /etc/systemd/system/summate.service
install -o root -g root -m 0644 \
  "${repo_dir}/deploy/summate-deploy.service" \
  /etc/systemd/system/summate-deploy.service
install -o root -g root -m 0644 \
  "${repo_dir}/deploy/summate-deploy.path" \
  /etc/systemd/system/summate-deploy.path
install -o root -g root -m 0644 \
  "${repo_dir}/deploy/summate-deploy.timer" \
  /etc/systemd/system/summate-deploy.timer
if id summate-runner >/dev/null 2>&1 && [ -f /etc/systemd/system/summate-runner.service ]; then
  runner_uid=$(id -u summate-runner)
  temporary_runner_unit=$(mktemp /run/summate-runner.service.XXXXXX)
  trap 'rm -f "${temporary_runner_unit}"' EXIT
  sed "s/RUNNER_UID/${runner_uid}/g" \
    "${repo_dir}/deploy/summate-runner.service" \
    > "${temporary_runner_unit}"
  install -o root -g root -m 0644 \
    "${temporary_runner_unit}" \
    /etc/systemd/system/summate-runner.service
  rm -f "${temporary_runner_unit}"
  trap - EXIT
  install -o root -g root -m 0644 \
    "${repo_dir}/deploy/summate-ash-seo.service" \
    /etc/systemd/system/summate-ash-seo.service
  install -o root -g root -m 0644 \
    "${repo_dir}/deploy/summate-ash-seo.timer" \
    /etc/systemd/system/summate-ash-seo.timer
fi
systemctl daemon-reload
if systemctl is-enabled --quiet summate-runner.service 2>/dev/null; then
  systemctl restart summate-runner.service
fi
systemctl enable summate
systemctl enable summate-deploy.path summate-deploy.timer
if ! systemctl restart summate; then
  systemctl status summate --no-pager || true
  journalctl -u summate -n 100 --no-pager || true
  printf '%s\n' 'Summate failed during systemd startup.' >&2
  exit 1
fi

for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:8765/health >/dev/null; then
    systemctl start summate-deploy.path summate-deploy.timer
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
