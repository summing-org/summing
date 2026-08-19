import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const asset = (path: string): string => readFileSync(join(root, path), "utf8");

test("deployment assets use an atomic release and one timer/path worker", () => {
  const script = asset("deploy/summing-deploy");
  const report = asset("deploy/summing-deploy-report");
  const cutoverPath = join(root, "deploy/project-environment-cutover");
  const cutover = asset("deploy/project-environment-cutover");
  const systemdSyncPath = join(root, "deploy/sync-systemd-units");
  const systemdSync = asset("deploy/sync-systemd-units");
  const timer = asset("deploy/summing-deploy.timer");
  const path = asset("deploy/summing-deploy.path");
  const service = asset("deploy/summing-deploy.service");
  const activation = asset("deploy/activate.sh");
  const runnerInstallerPath = join(root, "deploy/install-project-runner-host");
  const runnerInstaller = asset("deploy/install-project-runner-host");
  const projectRunnerService = asset("deploy/summing-project-runner.service");
  const cloudInit = asset("deploy/cloud-init.yaml");

  const syntax = spawnSync("bash", ["-n", join(root, "deploy/summing-deploy")], {
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  const cutoverSyntax = spawnSync("bash", ["-n", cutoverPath], { encoding: "utf8" });
  assert.equal(cutoverSyntax.status, 0, cutoverSyntax.stderr);
  const systemdSyncSyntax = spawnSync("bash", ["-n", systemdSyncPath], {
    encoding: "utf8",
  });
  assert.equal(systemdSyncSyntax.status, 0, systemdSyncSyntax.stderr);
  const runnerInstallerSyntax = spawnSync("bash", ["-n", runnerInstallerPath], {
    encoding: "utf8",
  });
  assert.equal(runnerInstallerSyntax.status, 0, runnerInstallerSyntax.stderr);
  assert.notEqual(statSync(cutoverPath).mode & 0o111, 0, "cutover hook must be executable");
  assert.notEqual(
    statSync(systemdSyncPath).mode & 0o111,
    0,
    "systemd sync hook must be executable",
  );
  assert.notEqual(
    statSync(runnerInstallerPath).mode & 0o111,
    0,
    "project runner installer must be executable",
  );
  assert.match(script, /git_as_summing -C "\$\{repo_dir\}" fetch --prune/);
  assert.match(script, /SUMMING_DEPLOY_EXPECTED_REMOTE/);
  assert.match(script, /runuser -u summing-builder -- env -i/);
  assert.match(script, /run_builder_phase dependencies dependencies/);
  assert.match(script, /run_builder_phase lint lint/);
  assert.match(script, /run_builder_phase tests test/);
  assert.match(script, /run_builder_phase prune prune/);
  assert.match(script, /summing-deploy-report/);
  assert.match(report, /failedTests: \$failedTests/);
  assert.match(script, /record_attempt/);
  assert.match(script, /history_limit=20/);
  assert.match(script, /install -d -o root -g summing -m 1770 "\$\{state_dir\}"/);
  assert.match(script, /install -d -o root -g summing -m 1770 "\$\{event_dir\}"/);
  assert.match(script, /write_deployment_event update_failed/);
  assert.match(script, /write_deployment_event update_succeeded/);
  assert.match(script, /chown summing:summing "\$\{temporary\}"/);
  assert.match(script, /Источник \$\{remote\} не одобрен политикой deployment/);
  assert.doesNotMatch(script, /temporary="\$\{state_file\}\.\$\$\.tmp"/);
  assert.match(script, /summing-builder must not belong to the secret-bearing summing group/);
  assert.match(script, /Предыдущая попытка не удалась; ждём новый commit или ручной повтор/);
  assert.match(script, /merge-base --is-ancestor/);
  assert.match(script, /mv -Tf "\$\{next_link\}" "\$\{current_link\}"/);
  assert.match(script, /rolling_back/);
  assert.match(script, /wait_for_idle_runtime/);
  assert.match(script, /sync_project_runner_configs\(\)/);
  assert.match(script, /assets=\("\$\{release\}"\/deploy\/\*\.runner\.json\)/);
  assert.match(script, /Managed runner config must not be a symlink/);
  assert.match(script, /\. \+ \{envPath: \$envPath\}/);
  assert.match(
    script,
    /runner_config_backup_dir=\$\(mktemp -d \/run\/summing-project-runner-configs/,
  );
  assert.match(script, /install_project_runner_host\(\)/);
  assert.match(script, /SUMMING_PROJECT_RUNNER_RELEASE="\$\{release\}"/);
  assert.match(script, /SUMMING_PROJECT_RUNNER_INSTALL_STATIC_CONFIGS=0/);
  assert.match(script, /restore_project_runner_configs\(\)/);
  assert.match(script, /if ! restore_project_runner_configs; then/);
  assert.match(script, /mv -f -- "\$\{candidate\}" "\$\{target\}"/);
  assert.match(script, /sync_project_runner_configs "\$\{previous_target\}"/);
  assert.match(script, /sync_project_runner_configs "\$\{release_dir\}"/);
  assert.match(script, /sync_systemd_units\(\)/);
  assert.match(script, /sync_systemd_units "\$\{previous_target\}"/);
  assert.match(script, /sync_systemd_units "\$\{release_dir\}"/);
  const unchangedRelease = script.indexOf('if [ "${previous_sha}" = "${target_sha}" ]; then');
  const unchangedSync = script.indexOf(
    'sync_project_runner_configs "${previous_target}"',
    unchangedRelease,
  );
  const unchangedRunnerInstall = script.indexOf(
    'install_project_runner_host "${previous_target}"',
    unchangedRelease,
  );
  const unchangedUnitSync = script.indexOf(
    'sync_systemd_units "${previous_target}"',
    unchangedSync,
  );
  const unchangedCutover = script.indexOf(
    'finalize_project_environment_cutover "${previous_target}"',
    unchangedRelease,
  );
  assert.ok(
    unchangedRelease >= 0 && unchangedRunnerInstall > unchangedRelease &&
      unchangedSync > unchangedRunnerInstall,
  );
  assert.ok(unchangedUnitSync > unchangedSync && unchangedCutover > unchangedUnitSync);
  const releaseSwitch = script.indexOf('switch_current "${release_dir}"');
  const releaseSync = script.indexOf(
    'sync_project_runner_configs "${release_dir}"',
    releaseSwitch,
  );
  const releaseRunnerInstall = script.indexOf(
    'install_project_runner_host "${release_dir}"',
    releaseSwitch,
  );
  const releaseRestart = script.indexOf("restart_services", releaseSync);
  assert.ok(
    releaseSwitch >= 0 && releaseRunnerInstall > releaseSwitch &&
      releaseSync > releaseRunnerInstall,
  );
  assert.ok(releaseRestart > releaseSync, "new configs must be installed before runner restart");
  const releaseHealth = script.indexOf("wait_for_health", releaseRestart);
  const releaseUnitSync = script.indexOf(
    'sync_systemd_units "${release_dir}"',
    releaseHealth,
  );
  const releaseCommit = script.indexOf("switched=0", releaseUnitSync);
  assert.ok(releaseHealth > releaseRestart && releaseUnitSync > releaseHealth);
  assert.ok(releaseCommit > releaseUnitSync, "unit sync must finish before release commit");
  assert.match(script, /finalize_project_environment_cutover "\$\{previous_target\}"/);
  assert.match(script, /finalize_project_environment_cutover "\$\{release_dir\}"/);
  assert.match(script, /cutover_status.*75/);
  assert.match(script, /Версия установлена; ждём Validate\/Dry run для migration cutover/);
  assert.match(script, /"\$\{prior_status\}" = waiting/);
  assert.doesNotMatch(script, /git .*\b(?:pull|reset|checkout)\b/);
  assert.doesNotMatch(service, /summing\.env/);
  assert.match(service, /ExecStart=\/opt\/summing-current\/deploy\/summing-deploy/);
  assert.match(timer, /OnUnitActiveSec=30min/);
  assert.match(systemdSync, /units=\([\s\S]*summing\.service[\s\S]*summing-deploy\.timer/);
  assert.match(systemdSync, /backup_dir=\$\(mktemp -d/);
  assert.match(systemdSync, /trap rollback ERR/);
  assert.match(systemdSync, /mv -f -- "\$\{temporary\}" "\$\{target_path\}"/);
  assert.match(systemdSync, /"\$\{systemctl_command\}" daemon-reload/);
  assert.match(systemdSync, /"\$\{systemctl_command\}" restart summing-deploy\.path/);
  assert.match(systemdSync, /"\$\{systemctl_command\}" restart summing-deploy\.timer/);
  assert.doesNotMatch(systemdSync, /restart summing-deploy\.service/);
  assert.match(cutover, /SUMMING_SYSTEMD_RELEASE="\$\{release_root\}" "\$\{systemd_sync\}"/);
  assert.ok(
    cutover.indexOf('SUMMING_SYSTEMD_RELEASE="${release_root}" "${systemd_sync}"') <
      cutover.indexOf('if [ ! -f "${imported_marker}" ]'),
    "the compatibility sync must run even when no environment migration exists",
  );
  assert.match(path, /PathChanged=\/var\/lib\/summing\/deploy\/request\.json/);
  assert.match(activation, /systemctl start summing-deploy\.path summing-deploy\.timer/);
  assert.match(activation, /kb_transfer_key=\/etc\/summing\/kb-transfer\.key/);
  assert.match(activation, /KB transfer key must be a regular file containing 64 hex characters/);
  assert.match(activation, /install -d -o root -g summing -m 1770 "\$\{deploy_state_dir\}"/);
  assert.match(activation, /deploy\/install-project-runner-host/);
  assert.match(activation, /summing-builder must not belong to the secret-bearing summing group/);
  assert.match(activation, /runuser -u summing-builder -- env -i/);
  assert.match(activation, /chown -R summing:summing "\$\{repo_dir\}"/);
  assert.match(activation, /Initial release build failed with exit code/);
  assert.match(activation, /\n  openssh-client\n/);
  assert.match(cloudInit, /\n  - openssh-client\n/);
  assert.doesNotMatch(activation, /systemctl restart summing-secrets\.service/);
  assert.match(
    projectRunnerService,
    /ReadWritePaths=.*\/var\/lib\/summing-project-runs(?:\s|$)/,
    "the hardened runner must be able to create persistent dry-run artifacts",
  );
  assert.match(cutover, /if \[ ! -f "\$\{verified_marker\}" \]/);
  assert.match(cutover, /prepare_environment_verification/);
  assert.match(cutover, /exit 75/);
  assert.match(cutover, /release_config=\$\{release_root\}\/deploy\/\$\{project_id\}\.runner\.json/);
  assert.match(cutover, /jq '\.network = true'/);
  assert.match(cutover, /chown --reference="\$\{config_path\}"/);
  assert.match(cutover, /Encrypted environment changed after Validate\/Dry run verification/);
  assert.match(cutover, /del\(\.envPath\)/);
  assert.match(cutover, /systemctl restart summing-project-runner\.service/);
  assert.match(cutover, /systemctl disable --now summing-secrets\.service/);
  assert.match(cutover, /legacyBrokerDataPreserved: true/);
  assert.match(cutover, /project-config\.before\.json/);
  assert.match(cutover, /Caddyfile\.before/);
  assert.match(cutover, /trap rollback ERR/);
  assert.match(runnerInstaller, /runner_user=summing-project-runner/);
  assert.match(runnerInstaller, /usermod --append --groups "\$\{runner_user\}" summing/);
  assert.doesNotMatch(
    runnerInstaller,
    /usermod --append --groups summing "\$\{runner_user\}"/,
  );
  assert.match(runnerInstaller, /\n  acl\n/);
  assert.match(
    runnerInstaller,
    /setfacl -P -R -m "g:\$\{runner_user\}:rX" "\$\{release_root\}"/,
  );
  assert.match(
    runnerInstaller,
    /runuser -u "\$\{runner_user\}" -- \\\n  test -r "\$\{release_root\}\/dist\/src\/project-runner-main\.js"/,
  );
  assert.match(runnerInstaller, /systemctl enable summing-project-runner\.service/);
  assert.match(runnerInstaller, /\/run\/summing-project-runner\/runner\.sock/);
  assert.match(runnerInstaller, /range_in_use\(\)/);
  assert.doesNotMatch(runnerInstaller, /systemctl disable --now docker\.service/);
  assert.doesNotMatch(
    runnerInstaller,
    /\/etc\/systemd\/system\/summing-runner\.service/,
    "the project runner installer must not replace an unrelated external runner unit",
  );
});

test("Project Viewer installer supports an HTTPS domain transition", () => {
  const path = join(root, "deploy/install-project-operations.sh");
  const installer = readFileSync(path, "utf8");
  const syntax = spawnSync("bash", ["-n", path], { encoding: "utf8" });

  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(installer, /SUMMING_VIEWER_REDIRECT_DOMAIN/);
  assert.match(installer, /redir https:\/\/%s\{uri\} permanent/);
  assert.match(installer, /caddy validate --config "\$\{temporary_caddy\}"/);
  assert.match(installer, /mktemp \/etc\/caddy\/Caddyfile\.XXXXXX/);
  assert.match(installer, /mv -f "\$\{temporary_caddy\}" \/etc\/caddy\/Caddyfile/);
});

test("all production processes execute through the current release symlink", () => {
  for (const path of [
    "deploy/summing.service",
    "deploy/summing-project-runner.service",
    "deploy/summing-ash-seo.service",
  ]) {
    assert.match(asset(path), /\/opt\/summing-current\/dist\/src\//, path);
  }
});

test("runner environment deployment keeps its encryption key private and one HTTPS origin", () => {
  const installerPath = join(root, "deploy/install-project-operations.sh");
  const installer = asset("deploy/install-project-operations.sh");
  const hostInstaller = asset("deploy/install-project-runner-host");
  const service = asset("deploy/summing-project-runner.service");
  const caddy = asset("deploy/Caddyfile.viewer");
  const syntax = spawnSync("bash", ["-n", installerPath], { encoding: "utf8" });

  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(hostInstaller, /openssl rand -hex 32/);
  assert.match(hostInstaller, /install -o "\$\{runner_user\}" -g "\$\{runner_user\}" -m 0400/);
  assert.match(
    service,
    /SUMMING_RUNNER_ENV_KEY=\/etc\/summing-project-runner\/environment\.key/,
  );
  assert.match(service, /User=summing-project-runner/);
  assert.match(service, /Group=summing-project-runner/);
  assert.doesNotMatch(service, /Group=summing\n/);
  assert.match(service, /ProtectSystem=strict/);
  assert.doesNotMatch(service, /SUMMING_SECRETS/);
  assert.doesNotMatch(caddy, /connections|8767/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8766/);
  assert.match(installer, /Keeping the legacy Connections route until environment verification succeeds/);
  assert.match(installer, /\. \+ \{envPath: \$envPath\}/);
  assert.doesNotMatch(installer, /ash-seo\.config\.json/);
  assert.deepEqual(
    JSON.parse(asset("deploy/ash-seo.runner.json")).configSourcePaths,
    ["config.json", "config.example.json"],
  );
  assert.match(
    service,
    /SUMMING_RUNNER_SCHEDULES=\/etc\/summing-project-runner\/schedules/,
  );
});

test("host identity migration is guarded, recoverable, and preserves worktrees", () => {
  const path = join(root, "deploy/migrate-host-to-summing");
  const migration = readFileSync(path, "utf8");
  const syntax = spawnSync("bash", ["-n", path], { encoding: "utf8" });

  assert.equal(syntax.status, 0, syntax.stderr);
  assert.notEqual(statSync(path).mode & 0o111, 0, "migration must be executable");
  assert.match(migration, /retired_name="sum""mate"/);
  assert.match(migration, /SUMMING_BACKUP_CONFIRMED/);
  assert.match(migration, /SUMMING_SNAPSHOT_WAIVED/);
  assert.match(migration, /backup_mode=\$\{backup_mode\}/);
  assert.match(migration, /set only one of SUMMING_BACKUP_CONFIRMED or SUMMING_SNAPSHOT_WAIVED/);
  assert.match(migration, /trap 'on_error \$\? \$\{LINENO\}' ERR/);
  assert.match(migration, /\.active \/\/ 0/);
  assert.match(migration, /git ls-remote --exit-code/);
  assert.match(migration, /sqlite3 "\$\{retired_home\}\/data\/state\.sqlite3"/);
  assert.match(migration, /\.backup '\$\{recovery_dir\}\/state\.sqlite3'/);
  assert.match(migration, /usermod --login/);
  assert.match(migration, /groupmod --new-name/);
  assert.match(migration, /git -C "\$\{worktree\}" branch -m/);
  assert.match(migration, /rewrite_absolute_symlinks "\$\{product_home\}"/);
  assert.match(migration, /rewrite_absolute_symlinks "\$\{product_runner_home\}"/);
  assert.match(migration, /"\$\{product_home\}\/\.ssh\/\$\{retired_name\}_github"/);
  assert.match(migration, /rewrite_file "\$\{product_home\}\/\.ssh\/config"/);
  assert.match(migration, /rewrite_tree "\$\{product_home\}\/\.ssh\/config\.d"/);
  assert.match(migration, /hostnamectl set-hostname "\$\{target_hostname\}"/);
  assert.match(migration, /systemctl disable \\\n+  "\$\{retired_name\}-runner\.service"/);
  assert.match(migration, /systemctl reset-failed/);
  assert.match(migration, /pre-9-releases/);
  assert.match(migration, /source_version=.*VERSION/);
  assert.match(migration, /9\.\*\)/);
  assert.match(migration, /"\$\{product_repo\}\/deploy\/activate\.sh"/);
  assert.match(migration, /\/run\/summing-project-runner\/runner\.sock/);
  assert.doesNotMatch(migration, /rm\s+-rf/);
});
