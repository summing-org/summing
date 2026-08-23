#!/usr/bin/env bash
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
  printf '%s\n' 'Run this script as root.' >&2
  exit 2
fi

viewer_domain=${SUMMING_VIEWER_DOMAIN:-}
viewer_redirect_domain=${SUMMING_VIEWER_REDIRECT_DOMAIN:-}
legacy_project_unit=${SUMMING_LEGACY_PROJECT_UNIT:-}
repo_dir=/opt/summing

if [ -z "${viewer_domain}" ]; then
  printf '%s\n' 'Set SUMMING_VIEWER_DOMAIN.' >&2
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
if [ -n "${legacy_project_unit}" ] && \
  ! printf '%s' "${legacy_project_unit}" | grep -Eq '^[a-z0-9][a-z0-9@_.-]{0,127}$'; then
  printf '%s\n' 'SUMMING_LEGACY_PROJECT_UNIT must be an exact systemd unit basename.' >&2
  exit 2
fi
if [[ "${legacy_project_unit}" == *.service ]] || [[ "${legacy_project_unit}" == *.timer ]]; then
  printf '%s\n' 'SUMMING_LEGACY_PROJECT_UNIT must not include .service or .timer.' >&2
  exit 2
fi

SUMMING_PROJECT_RUNNER_RELEASE="${repo_dir}" \
  "${repo_dir}/deploy/install-project-runner-host"

preserve_legacy_connections=0
if [ -f /etc/caddy/Caddyfile ] && \
  grep -Fq 'handle /connections* {' /etc/caddy/Caddyfile; then
  preserve_legacy_connections=1
fi

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
if [ "${preserve_legacy_connections}" != 1 ] || [ ! -f /etc/caddy/Caddyfile ]; then
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
  printf '%s\n' \
    'SUMMING_RUNNER_SOCKET=/run/summing-project-runner/runner.sock' >> "${env_file}"
fi
chown root:summing "${env_file}"
chmod 0640 "${env_file}"

ufw allow 80/tcp
ufw allow 443/tcp
systemctl daemon-reload
systemctl enable summing-project-runner.service
systemctl restart summing-project-runner.service
systemctl enable caddy.service
systemctl restart caddy.service

runner_healthy=0
for attempt in $(seq 1 30); do
  if curl --fail --silent --unix-socket /run/summing-project-runner/runner.sock \
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
if [ -n "${legacy_project_unit}" ]; then
  systemctl disable --now "${legacy_project_unit}.timer" >/dev/null 2>&1 || true
  systemctl stop "${legacy_project_unit}.service" >/dev/null 2>&1 || true
  printf 'Disabled explicitly selected legacy Project unit: %s.\n' "${legacy_project_unit}"
fi
printf '%s\n' 'Project Viewer and the generic isolated project runner are installed.'
