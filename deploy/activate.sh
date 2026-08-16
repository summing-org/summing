#!/usr/bin/env bash
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
  printf '%s\n' 'Run this script as root.' >&2
  exit 2
fi

repo_dir=/opt/summing
current_link=/opt/summing-current
data_dir=/var/lib/summing/data
deploy_state_dir=/var/lib/summing/deploy
env_file=/etc/summing/summing.env
deploy_env_file=/etc/summing/deploy.env
config_file="${data_dir}/config.toml"

if [ ! -f "${repo_dir}/package.json" ]; then
  printf 'SUMMING source is missing from %s.\n' "${repo_dir}" >&2
  exit 2
fi
if ! id summing >/dev/null 2>&1; then
  printf '%s\n' 'The summing user is missing; run deploy/cloud-init.yaml first.' >&2
  exit 2
fi
if ! id summing-builder >/dev/null 2>&1; then
  useradd \
    --system \
    --create-home \
    --home-dir /var/lib/summing-builder \
    --shell /usr/sbin/nologin \
    summing-builder
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
  openssh-client
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
if ! sudo -u summing bwrap --ro-bind / / --dev /dev --proc /proc /bin/true; then
  printf '%s\n' \
    'bubblewrap user namespaces are unavailable; check the bwrap AppArmor profile.' >&2
  exit 2
fi

install -d -o summing -g summing -m 0700 "${data_dir}"
install -d -o summing -g summing -m 0700 "${data_dir}/codex"
install -d -o summing -g summing -m 0700 "${data_dir}/worktrees"
install -d -o root -g summing -m 1770 "${deploy_state_dir}"
install -d -o summing-builder -g summing-builder -m 0700 /var/lib/summing-builder
install -d -o root -g summing -m 0750 /etc/summing
install -d -o root -g root -m 0755 /etc/codex
install -o root -g root -m 0644 \
  "${repo_dir}/deploy/codex-requirements.toml" \
  /etc/codex/requirements.toml
if [ ! -f "${config_file}" ]; then
  install -o summing -g summing -m 0600 \
    "${repo_dir}/deploy/config.production.toml" \
    "${config_file}"
fi
if [ ! -f "${env_file}" ]; then
  install -o root -g summing -m 0640 \
    "${repo_dir}/summing.env.example" \
    "${env_file}"
fi
if [ ! -f "${deploy_env_file}" ]; then
  install -o root -g root -m 0600 \
    "${repo_dir}/deploy/summing-deploy.env.example" \
    "${deploy_env_file}"
fi
if ! grep -q '^SUMMING_DEPLOY_REQUEST=' "${env_file}"; then
  printf '%s\n' \
    'SUMMING_DEPLOY_REQUEST=/var/lib/summing/deploy/request.json' >> "${env_file}"
fi
if ! grep -q '^SUMMING_DEPLOY_STATE=' "${env_file}"; then
  printf '%s\n' \
    'SUMMING_DEPLOY_STATE=/var/lib/summing/deploy/state.json' >> "${env_file}"
fi
chown summing:summing "${config_file}"
chmod 0600 "${config_file}"
chown root:summing "${env_file}"
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

chown -R summing:summing "${repo_dir}"
sudo -u summing \
  env HOME=/var/lib/summing PATH=/usr/local/bin:/usr/bin:/bin \
  bash -c \
  'cd /opt/summing && npm ci && npm run lint && npm test && npm prune --omit=dev'

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
  "${repo_dir}/deploy/summing.service" \
  /etc/systemd/system/summing.service
install -o root -g root -m 0644 \
  "${repo_dir}/deploy/summing-deploy.service" \
  /etc/systemd/system/summing-deploy.service
install -o root -g root -m 0644 \
  "${repo_dir}/deploy/summing-deploy.path" \
  /etc/systemd/system/summing-deploy.path
install -o root -g root -m 0644 \
  "${repo_dir}/deploy/summing-deploy.timer" \
  /etc/systemd/system/summing-deploy.timer
if id summing-runner >/dev/null 2>&1 && [ -f /etc/systemd/system/summing-runner.service ]; then
  runner_uid=$(id -u summing-runner)
  if [ ! -f /etc/summing-runner/environment.key ]; then
    install -d -o root -g summing -m 0750 /etc/summing-runner
    if [ -L /var/lib/summing-runner/environment.key ]; then
      printf '%s\n' 'Bootstrap runner environment key must not be a symlink.' >&2
      exit 2
    elif [ -f /var/lib/summing-runner/environment.key ]; then
      fallback_key_mode=$(stat -c '%a' /var/lib/summing-runner/environment.key)
      if { [ "${fallback_key_mode}" != 400 ] && [ "${fallback_key_mode}" != 600 ]; } || \
        ! grep -Eq '^[0-9a-fA-F]{64}$' /var/lib/summing-runner/environment.key; then
        printf '%s\n' 'Bootstrap runner environment key is invalid.' >&2
        exit 2
      fi
      install -o summing-runner -g summing-runner -m 0400 \
        /var/lib/summing-runner/environment.key \
        /etc/summing-runner/environment.key
      if ! cmp -s /var/lib/summing-runner/environment.key \
        /etc/summing-runner/environment.key; then
        printf '%s\n' 'Runner environment key copy verification failed.' >&2
        exit 2
      fi
      rm -f /var/lib/summing-runner/environment.key
    else
      temporary_environment_key=$(mktemp /run/summing-runner-environment.XXXXXX)
      openssl rand -hex 32 > "${temporary_environment_key}"
      install -o summing-runner -g summing-runner -m 0400 \
        "${temporary_environment_key}" /etc/summing-runner/environment.key
      rm -f "${temporary_environment_key}"
    fi
  fi
  temporary_runner_unit=$(mktemp /run/summing-runner.service.XXXXXX)
  trap 'rm -f "${temporary_runner_unit}"' EXIT
  sed "s/RUNNER_UID/${runner_uid}/g" \
    "${repo_dir}/deploy/summing-runner.service" \
    > "${temporary_runner_unit}"
  install -o root -g root -m 0644 \
    "${temporary_runner_unit}" \
    /etc/systemd/system/summing-runner.service
  rm -f "${temporary_runner_unit}"
  trap - EXIT
  install -o root -g root -m 0644 \
    "${repo_dir}/deploy/summing-ash-seo.service" \
    /etc/systemd/system/summing-ash-seo.service
  install -o root -g root -m 0644 \
    "${repo_dir}/deploy/summing-ash-seo.timer" \
    /etc/systemd/system/summing-ash-seo.timer
fi
systemctl daemon-reload
if systemctl is-enabled --quiet summing-runner.service 2>/dev/null; then
  systemctl restart summing-runner.service
fi
systemctl enable summing
systemctl enable summing-deploy.path summing-deploy.timer
if ! systemctl restart summing; then
  systemctl status summing --no-pager || true
  journalctl -u summing -n 100 --no-pager || true
  printf '%s\n' 'SUMMING failed during systemd startup.' >&2
  exit 1
fi

runner_required=0
if systemctl is-enabled --quiet summing-runner.service 2>/dev/null; then runner_required=1; fi
for _ in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:8765/health >/dev/null; then
    if [ "${runner_required}" = 0 ] || \
      curl --fail --silent --unix-socket /run/summing-runner/runner.sock \
        http://localhost/health >/dev/null 2>&1; then
      systemctl start summing-deploy.path summing-deploy.timer
      printf '%s\n' 'SUMMING and the project runner are active.'
      exit 0
    fi
  fi
  if ! systemctl is-active --quiet summing; then
    break
  fi
  sleep 1
done

systemctl status summing --no-pager || true
journalctl -u summing -n 100 --no-pager || true
printf '%s\n' 'SUMMING did not become healthy.' >&2
exit 1
