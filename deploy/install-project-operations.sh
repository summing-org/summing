#!/usr/bin/env bash
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
  printf '%s\n' 'Run this script as root.' >&2
  exit 2
fi

viewer_domain=${SUMMING_VIEWER_DOMAIN:-}
viewer_redirect_domain=${SUMMING_VIEWER_REDIRECT_DOMAIN:-}
ash_seo_revision=${ASH_SEO_REVISION:-}
enable_timer=${ENABLE_ASH_SEO_TIMER:-0}
repo_dir=/opt/summing
runner_home=/var/lib/summing-runner
runner_user=summing-runner

if [ -z "${viewer_domain}" ] || [ -z "${ash_seo_revision}" ]; then
  printf '%s\n' 'Set SUMMING_VIEWER_DOMAIN and ASH_SEO_REVISION.' >&2
  exit 2
fi
if ! printf '%s' "${viewer_domain}" | grep -Eq '^[a-z0-9.-]+$'; then
  printf '%s\n' 'SUMMING_VIEWER_DOMAIN is invalid.' >&2
  exit 2
fi
if [ -n "${viewer_redirect_domain}" ] && \
  ! printf '%s' "${viewer_redirect_domain}" | grep -Eq '^[a-z0-9.-]+$'; then
  printf '%s\n' 'SUMMING_VIEWER_REDIRECT_DOMAIN is invalid.' >&2
  exit 2
fi
if [ -n "${viewer_redirect_domain}" ] && \
  [ "${viewer_redirect_domain}" = "${viewer_domain}" ]; then
  printf '%s\n' 'SUMMING_VIEWER_REDIRECT_DOMAIN must differ from SUMMING_VIEWER_DOMAIN.' >&2
  exit 2
fi
if ! printf '%s' "${ash_seo_revision}" | grep -Eq '^[0-9a-f]{40}$'; then
  printf '%s\n' 'ASH_SEO_REVISION must be a full commit SHA.' >&2
  exit 2
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg openssl uidmap dbus-user-session slirp4netns fuse-overlayfs

if ! dpkg-query -W -f='${Status}' docker-ce >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  architecture=$(dpkg --print-architecture)
  codename=$(. /etc/os-release && printf '%s' "${VERSION_CODENAME}")
  printf '%s\n' \
    'Types: deb' \
    'URIs: https://download.docker.com/linux/ubuntu' \
    "Suites: ${codename}" \
    'Components: stable' \
    "Architectures: ${architecture}" \
    'Signed-By: /etc/apt/keyrings/docker.asc' \
    > /etc/apt/sources.list.d/docker.sources
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin docker-ce-rootless-extras
fi
systemctl disable --now docker.service docker.socket >/dev/null 2>&1 || true

if ! id "${runner_user}" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "${runner_home}" --shell /bin/bash "${runner_user}"
fi
runner_group_changed=0
if ! id -nG "${runner_user}" | tr ' ' '\n' | grep -qx summing; then
  usermod --append --groups summing "${runner_user}"
  runner_group_changed=1
fi
if ! grep -q "^${runner_user}:" /etc/subuid; then
  usermod --add-subuids 231072-296607 "${runner_user}"
fi
if ! grep -q "^${runner_user}:" /etc/subgid; then
  usermod --add-subgids 231072-296607 "${runner_user}"
fi
runner_uid=$(id -u "${runner_user}")
loginctl enable-linger "${runner_user}"
if [ "${runner_group_changed}" = 1 ]; then
  systemctl stop "user@${runner_uid}.service" >/dev/null 2>&1 || true
fi
systemctl start "user@${runner_uid}.service"

runner_env=(
  "HOME=${runner_home}"
  "XDG_RUNTIME_DIR=/run/user/${runner_uid}"
  "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${runner_uid}/bus"
)
if [ ! -S "/run/user/${runner_uid}/docker.sock" ]; then
  runuser -u "${runner_user}" -- env "${runner_env[@]}" dockerd-rootless-setuptool.sh install --force
fi
install -d -o "${runner_user}" -g "${runner_user}" -m 0700 "${runner_home}/.config/docker"
install -o "${runner_user}" -g "${runner_user}" -m 0600 \
  "${repo_dir}/deploy/docker-rootless-daemon.json" \
  "${runner_home}/.config/docker/daemon.json"
runuser -u "${runner_user}" -- env "${runner_env[@]}" systemctl --user restart docker

install -d -o root -g summing -m 0750 /etc/summing-runner
install -d -o root -g summing -m 0750 /etc/summing-runner/projects
install -d -o root -g summing -m 0750 /etc/summing-runner/schedules
if [ ! -f /etc/summing-runner/environment.key ]; then
  temporary_environment_key=$(mktemp /run/summing-runner-environment.XXXXXX)
  openssl rand -hex 32 > "${temporary_environment_key}"
  install -o "${runner_user}" -g "${runner_user}" -m 0400 \
    "${temporary_environment_key}" /etc/summing-runner/environment.key
  rm -f "${temporary_environment_key}"
fi
install -d -o "${runner_user}" -g "${runner_user}" -m 0700 "${runner_home}/jobs"
install -d -o "${runner_user}" -g "${runner_user}" -m 0700 /var/lib/summing-runs/ash-seo/data
runner_project_config=/etc/summing-runner/projects/ash-seo.json
legacy_env_path=
if [ -f "${runner_project_config}" ]; then
  legacy_env_path=$(jq -r '.envPath // empty' "${runner_project_config}")
fi
if [ -n "${legacy_env_path}" ]; then
  compatible_runner_config=$(mktemp /run/ash-seo-runner.XXXXXX)
  jq --arg envPath "${legacy_env_path}" '. + {envPath: $envPath}' \
    "${repo_dir}/deploy/ash-seo.runner.json" > "${compatible_runner_config}"
  install -o root -g summing -m 0640 \
    "${compatible_runner_config}" "${runner_project_config}"
  rm -f "${compatible_runner_config}"
else
  install -o root -g summing -m 0640 \
    "${repo_dir}/deploy/ash-seo.runner.json" "${runner_project_config}"
fi
if [ ! -f /etc/summing-runner/projects/ash-seo.env ]; then
  install -o root -g "${runner_user}" -m 0640 \
    "${repo_dir}/deploy/ash-seo.env.example" \
    /etc/summing-runner/projects/ash-seo.env
fi

sed "s/replace_me/${ash_seo_revision}/" "${repo_dir}/deploy/ash-seo.schedule.json" \
  > /etc/summing-runner/schedules/ash-seo.json
chown root:summing /etc/summing-runner/schedules/ash-seo.json
chmod 0640 /etc/summing-runner/schedules/ash-seo.json

sed "s/RUNNER_UID/${runner_uid}/g" \
  "${repo_dir}/deploy/summing-runner.service" \
  > /etc/systemd/system/summing-runner.service
chown root:root /etc/systemd/system/summing-runner.service
chmod 0644 /etc/systemd/system/summing-runner.service
install -o root -g root -m 0644 "${repo_dir}/deploy/summing-ash-seo.service" /etc/systemd/system/summing-ash-seo.service
install -o root -g root -m 0644 "${repo_dir}/deploy/summing-ash-seo.timer" /etc/systemd/system/summing-ash-seo.timer

if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o /etc/apt/keyrings/caddy-stable.key
  gpg --dearmor --batch --yes \
    --output /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    /etc/apt/keyrings/caddy-stable.key
  rm -f /etc/apt/keyrings/caddy-stable.key
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
fi
if [ -z "${legacy_env_path}" ] || [ ! -f /etc/caddy/Caddyfile ]; then
  temporary_caddy=$(mktemp /etc/caddy/Caddyfile.XXXXXX)
  trap 'rm -f "${temporary_caddy}"' EXIT
  sed "s/VIEWER_DOMAIN/${viewer_domain}/g" \
    "${repo_dir}/deploy/Caddyfile.viewer" > "${temporary_caddy}"
  if [ -n "${viewer_redirect_domain}" ]; then
    printf '\n%s {\n\tredir https://%s{uri} permanent\n}\n' \
      "${viewer_redirect_domain}" \
      "${viewer_domain}" \
      >> "${temporary_caddy}"
  fi
  caddy fmt --overwrite "${temporary_caddy}"
  caddy validate --config "${temporary_caddy}"
  chown root:root "${temporary_caddy}"
  chmod 0644 "${temporary_caddy}"
  mv -f "${temporary_caddy}" /etc/caddy/Caddyfile
  trap - EXIT
else
  printf '%s\n' 'Keeping the legacy Connections route until environment verification succeeds.'
fi

env_file=/etc/summing/summing.env
if ! grep -q '^SUMMING_VIEWER_URL=' "${env_file}"; then
  printf 'SUMMING_VIEWER_URL=https://%s\n' "${viewer_domain}" >> "${env_file}"
else
  sed -i "s|^SUMMING_VIEWER_URL=.*|SUMMING_VIEWER_URL=https://${viewer_domain}|" "${env_file}"
fi
if ! grep -q '^SUMMING_VIEWER_LOCAL_TOKEN=.' "${env_file}"; then
  local_token=$(openssl rand -hex 32)
  if grep -q '^SUMMING_VIEWER_LOCAL_TOKEN=' "${env_file}"; then
    sed -i "s|^SUMMING_VIEWER_LOCAL_TOKEN=.*|SUMMING_VIEWER_LOCAL_TOKEN=${local_token}|" "${env_file}"
  else
    printf 'SUMMING_VIEWER_LOCAL_TOKEN=%s\n' "${local_token}" >> "${env_file}"
  fi
fi
if ! grep -q '^SUMMING_RUNNER_SOCKET=' "${env_file}"; then
  printf '%s\n' 'SUMMING_RUNNER_SOCKET=/run/summing-runner/runner.sock' >> "${env_file}"
fi
chown root:summing "${env_file}"
chmod 0640 "${env_file}"

ufw allow 80/tcp
ufw allow 443/tcp
systemctl daemon-reload
systemctl enable summing-runner.service
systemctl restart summing-runner.service
systemctl enable caddy.service
systemctl restart caddy.service
if [ "${enable_timer}" = 1 ]; then
  systemctl enable --now summing-ash-seo.timer
else
  systemctl disable --now summing-ash-seo.timer >/dev/null 2>&1 || true
fi

runner_healthy=0
for attempt in $(seq 1 30); do
  if curl --fail --silent --unix-socket /run/summing-runner/runner.sock \
    http://localhost/health >/dev/null 2>&1; then
    runner_healthy=1
    break
  fi
  sleep 1
done
if [ "${runner_healthy}" != 1 ]; then
  printf '%s\n' 'Project runner did not become healthy within 30 seconds.' >&2
  exit 1
fi
printf '%s\n' 'Project Viewer and isolated runner with encrypted project environments are installed.'
