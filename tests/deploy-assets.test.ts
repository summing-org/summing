import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const asset = (path: string): string => readFileSync(join(root, path), "utf8");

test("deployment assets use an atomic release and one timer/path worker", () => {
  const script = asset("deploy/summing-deploy");
  const timer = asset("deploy/summing-deploy.timer");
  const path = asset("deploy/summing-deploy.path");
  const service = asset("deploy/summing-deploy.service");
  const activation = asset("deploy/activate.sh");

  const syntax = spawnSync("bash", ["-n", join(root, "deploy/summing-deploy")], {
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(script, /git_as_summing -C "\$\{repo_dir\}" fetch --prune/);
  assert.match(script, /SUMMING_DEPLOY_EXPECTED_REMOTE/);
  assert.match(script, /runuser -u summing-builder -- env -i/);
  assert.match(script, /summing-builder must not belong to the secret-bearing summing group/);
  assert.match(script, /Предыдущая попытка не удалась; ждём новый commit или ручной повтор/);
  assert.match(script, /merge-base --is-ancestor/);
  assert.match(script, /mv -Tf "\$\{next_link\}" "\$\{current_link\}"/);
  assert.match(script, /rolling_back/);
  assert.match(script, /wait_for_idle_runtime/);
  assert.doesNotMatch(script, /git .*\b(?:pull|reset|checkout)\b/);
  assert.doesNotMatch(service, /summing\.env/);
  assert.match(service, /ExecStart=\/opt\/summing-current\/deploy\/summing-deploy/);
  assert.match(timer, /OnUnitActiveSec=10min/);
  assert.match(path, /PathChanged=\/var\/lib\/summing\/deploy\/request\.json/);
  assert.match(activation, /systemctl start summing-deploy\.path summing-deploy\.timer/);
  assert.match(activation, /runner_uid=\$\(id -u summing-runner\)/);
  assert.match(activation, /sed "s\/RUNNER_UID\/\$\{runner_uid\}\/g"/);
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
