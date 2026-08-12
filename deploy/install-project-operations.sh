#!/usr/bin/env bash
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
  printf '%s\n' 'Run this script as root.' >&2
  exit 2
fi

viewer_domain=${SUMMATE_VIEWER_DOMAIN:-}
ash_seo_revision=${ASH_SEO_REVISION:-}
enable_timer=${ENABLE_ASH_SEO_TIMER:-0}
repo_dir=/opt/summate
runner_home=/var/lib/summate-runner
runner_user=summate-runner

if [ -z "${viewer_domain}" ] || [ -z "${ash_seo_revision}" ]; then
  printf '%s\n' 'Set SUMMATE_VIEWER_DOMAIN and ASH_SEO_REVISION.' >&2
  exit 2
fi
if ! printf '%s' "${viewer_domain}" | grep -Eq '^[a-z0-9.-]+$'; then
  printf '%s\n' 'SUMMATE_VIEWER_DOMAIN is invalid.' >&2
  exit 2
fi
if ! printf '%s' "${ash_seo_revision}" | grep -Eq '^[0-9a-f]{40}$'; then
  printf '%s\n' 'ASH_SEO_REVISION must be a full commit SHA.' >&2
  exit 2
fi

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg uidmap dbus-user-session slirp4netns fuse-overlayfs

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
if ! id -nG "${runner_user}" | tr ' ' '\n' | grep -qx summate; then
  usermod --append --groups summate "${runner_user}"
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

install -d -o root -g summate -m 0750 /etc/summate-runner
install -d -o root -g summate -m 0750 /etc/summate-runner/projects
install -d -o root -g summate -m 0750 /etc/summate-runner/schedules
install -d -o "${runner_user}" -g "${runner_user}" -m 0700 "${runner_home}/jobs"
install -d -o "${runner_user}" -g "${runner_user}" -m 0700 /var/lib/summate-runs/ash-seo/data
install -o root -g summate -m 0640 \
  "${repo_dir}/deploy/ash-seo.runner.json" \
  /etc/summate-runner/projects/ash-seo.json
if [ ! -f /etc/summate-runner/projects/ash-seo.env ]; then
  install -o root -g "${runner_user}" -m 0640 \
    "${repo_dir}/deploy/ash-seo.env.example" \
    /etc/summate-runner/projects/ash-seo.env
fi

ash_repo=/var/lib/summate/data/repositories/ash-seo/ash-seo
if [ ! -f /etc/summate-runner/projects/ash-seo.config.json ]; then
  temporary_config=$(mktemp)
  runuser -u summate -- git -C "${ash_repo}" show "${ash_seo_revision}:config.example.json" > "${temporary_config}"
  install -o root -g "${runner_user}" -m 0644 \
    "${temporary_config}" /etc/summate-runner/projects/ash-seo.config.json
  rm -f "${temporary_config}"
fi
sed "s/replace_me/${ash_seo_revision}/" "${repo_dir}/deploy/ash-seo.schedule.json" \
  > /etc/summate-runner/schedules/ash-seo.json
chown root:summate /etc/summate-runner/schedules/ash-seo.json
chmod 0640 /etc/summate-runner/schedules/ash-seo.json

sed "s/RUNNER_UID/${runner_uid}/g" \
  "${repo_dir}/deploy/summate-runner.service" \
  > /etc/systemd/system/summate-runner.service
chown root:root /etc/systemd/system/summate-runner.service
chmod 0644 /etc/systemd/system/summate-runner.service
install -o root -g root -m 0644 "${repo_dir}/deploy/summate-ash-seo.service" /etc/systemd/system/summate-ash-seo.service
install -o root -g root -m 0644 "${repo_dir}/deploy/summate-ash-seo.timer" /etc/systemd/system/summate-ash-seo.timer

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
sed "s/VIEWER_DOMAIN/${viewer_domain}/g" "${repo_dir}/deploy/Caddyfile.viewer" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile

env_file=/etc/summate/summate.env
if ! grep -q '^SUMMATE_VIEWER_URL=' "${env_file}"; then
  printf 'SUMMATE_VIEWER_URL=https://%s\n' "${viewer_domain}" >> "${env_file}"
else
  sed -i "s|^SUMMATE_VIEWER_URL=.*|SUMMATE_VIEWER_URL=https://${viewer_domain}|" "${env_file}"
fi
if ! grep -q '^SUMMATE_VIEWER_LOCAL_TOKEN=.' "${env_file}"; then
  local_token=$(openssl rand -hex 32)
  if grep -q '^SUMMATE_VIEWER_LOCAL_TOKEN=' "${env_file}"; then
    sed -i "s|^SUMMATE_VIEWER_LOCAL_TOKEN=.*|SUMMATE_VIEWER_LOCAL_TOKEN=${local_token}|" "${env_file}"
  else
    printf 'SUMMATE_VIEWER_LOCAL_TOKEN=%s\n' "${local_token}" >> "${env_file}"
  fi
fi
if ! grep -q '^SUMMATE_RUNNER_SOCKET=' "${env_file}"; then
  printf '%s\n' 'SUMMATE_RUNNER_SOCKET=/run/summate-runner/runner.sock' >> "${env_file}"
fi
chown root:summate "${env_file}"
chmod 0640 "${env_file}"

ufw allow 80/tcp
ufw allow 443/tcp
systemctl daemon-reload
systemctl enable summate-runner.service
systemctl restart summate-runner.service
systemctl enable caddy.service
systemctl restart caddy.service
if [ "${enable_timer}" = 1 ]; then
  systemctl enable --now summate-ash-seo.timer
else
  systemctl disable --now summate-ash-seo.timer >/dev/null 2>&1 || true
fi

curl --fail --silent --unix-socket /run/summate-runner/runner.sock http://localhost/health >/dev/null
printf '%s\n' 'Project Viewer proxy and isolated runner are installed.'
