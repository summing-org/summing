import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const asset = (path: string): string => readFileSync(join(root, path), "utf8");

test("deployment assets use an atomic release and one timer/path worker", () => {
  const script = asset("deploy/summing-deploy");
  const cutoverPath = join(root, "deploy/project-environment-cutover");
  const cutover = asset("deploy/project-environment-cutover");
  const timer = asset("deploy/summing-deploy.timer");
  const path = asset("deploy/summing-deploy.path");
  const service = asset("deploy/summing-deploy.service");
  const activation = asset("deploy/activate.sh");

  const syntax = spawnSync("bash", ["-n", join(root, "deploy/summing-deploy")], {
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  const cutoverSyntax = spawnSync("bash", ["-n", cutoverPath], { encoding: "utf8" });
  assert.equal(cutoverSyntax.status, 0, cutoverSyntax.stderr);
  assert.notEqual(statSync(cutoverPath).mode & 0o111, 0, "cutover hook must be executable");
  assert.match(script, /git_as_summing -C "\$\{repo_dir\}" fetch --prune/);
  assert.match(script, /SUMMING_DEPLOY_EXPECTED_REMOTE/);
  assert.match(script, /runuser -u summing-builder -- env -i/);
  assert.match(script, /summing-builder must not belong to the secret-bearing summing group/);
  assert.match(script, /Предыдущая попытка не удалась; ждём новый commit или ручной повтор/);
  assert.match(script, /merge-base --is-ancestor/);
  assert.match(script, /mv -Tf "\$\{next_link\}" "\$\{current_link\}"/);
  assert.match(script, /rolling_back/);
  assert.match(script, /wait_for_idle_runtime/);
  assert.match(script, /finalize_project_environment_cutover "\$\{previous_target\}"/);
  assert.match(script, /finalize_project_environment_cutover "\$\{release_dir\}"/);
  assert.doesNotMatch(script, /git .*\b(?:pull|reset|checkout)\b/);
  assert.doesNotMatch(service, /summing\.env/);
  assert.match(service, /ExecStart=\/opt\/summing-current\/deploy\/summing-deploy/);
  assert.match(timer, /OnUnitActiveSec=10min/);
  assert.match(path, /PathChanged=\/var\/lib\/summing\/deploy\/request\.json/);
  assert.match(activation, /systemctl start summing-deploy\.path summing-deploy\.timer/);
  assert.match(activation, /runner_uid=\$\(id -u summing-runner\)/);
  assert.match(activation, /sed "s\/RUNNER_UID\/\$\{runner_uid\}\/g"/);
  assert.doesNotMatch(activation, /systemctl restart summing-secrets\.service/);
  assert.match(
    asset("deploy/summing-runner.service"),
    /ReadWritePaths=.*\/var\/lib\/summing-runs(?:\s|$)/,
    "the hardened runner must be able to create persistent dry-run artifacts",
  );
  assert.match(cutover, /if \[ ! -f "\$\{verified_marker\}" \]/);
  assert.match(cutover, /Encrypted environment changed after Validate\/Dry run verification/);
  assert.match(cutover, /del\(\.envPath\)/);
  assert.match(cutover, /systemctl restart summing-runner\.service/);
  assert.match(cutover, /systemctl disable --now summing-secrets\.service/);
  assert.match(cutover, /legacyBrokerDataPreserved: true/);
  assert.match(cutover, /project-config\.before\.json/);
  assert.match(cutover, /Caddyfile\.before/);
  assert.match(cutover, /trap rollback ERR/);
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
    "deploy/summing-runner.service",
    "deploy/summing-ash-seo.service",
  ]) {
    assert.match(asset(path), /\/opt\/summing-current\/dist\/src\//, path);
  }
});

test("runner environment deployment keeps its encryption key private and one HTTPS origin", () => {
  const installerPath = join(root, "deploy/install-project-operations.sh");
  const installer = asset("deploy/install-project-operations.sh");
  const service = asset("deploy/summing-runner.service");
  const caddy = asset("deploy/Caddyfile.viewer");
  const syntax = spawnSync("bash", ["-n", installerPath], { encoding: "utf8" });

  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(installer, /openssl rand -hex 32/);
  assert.match(installer, /install -o "\$\{runner_user\}" -g "\$\{runner_user\}" -m 0400/);
  assert.match(service, /SUMMING_RUNNER_ENV_KEY=\/etc\/summing-runner\/environment\.key/);
  assert.match(service, /User=summing-runner/);
  assert.match(service, /ProtectSystem=strict/);
  assert.doesNotMatch(service, /SUMMING_SECRETS/);
  assert.doesNotMatch(caddy, /connections|8767/);
  assert.match(caddy, /reverse_proxy 127\.0\.0\.1:8766/);
  assert.match(installer, /Keeping the legacy Connections route until environment verification succeeds/);
  assert.match(installer, /\. \+ \{envPath: \$envPath\}/);
  assert.match(service, /SUMMING_RUNNER_SCHEDULES=\/etc\/summing-runner\/schedules/);
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
  assert.match(migration, /\/run\/summing-runner\/runner\.sock/);
  assert.doesNotMatch(migration, /rm\s+-rf/);
});
