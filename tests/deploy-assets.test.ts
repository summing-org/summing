import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = process.cwd();
const asset = (path: string): string => readFileSync(join(root, path), "utf8");

test("deployment assets use an atomic release and one timer/path worker", () => {
  const script = asset("deploy/summate-deploy");
  const timer = asset("deploy/summate-deploy.timer");
  const path = asset("deploy/summate-deploy.path");
  const service = asset("deploy/summate-deploy.service");
  const activation = asset("deploy/activate.sh");

  const syntax = spawnSync("bash", ["-n", join(root, "deploy/summate-deploy")], {
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(script, /git_as_summate -C "\$\{repo_dir\}" fetch --prune/);
  assert.match(script, /SUMMATE_DEPLOY_EXPECTED_REMOTE/);
  assert.match(script, /runuser -u summate-builder -- env -i/);
  assert.match(script, /summate-builder must not belong to the secret-bearing summate group/);
  assert.match(script, /Предыдущая попытка не удалась; ждём новый commit или ручной повтор/);
  assert.match(script, /merge-base --is-ancestor/);
  assert.match(script, /mv -Tf "\$\{next_link\}" "\$\{current_link\}"/);
  assert.match(script, /rolling_back/);
  assert.match(script, /wait_for_idle_runtime/);
  assert.doesNotMatch(script, /git .*\b(?:pull|reset|checkout)\b/);
  assert.doesNotMatch(service, /summate\.env/);
  assert.match(service, /ExecStart=\/opt\/summate-current\/deploy\/summate-deploy/);
  assert.match(timer, /OnUnitActiveSec=10min/);
  assert.match(path, /PathChanged=\/var\/lib\/summate\/deploy\/request\.json/);
  assert.match(activation, /systemctl start summate-deploy\.path summate-deploy\.timer/);
});

test("all production processes execute through the current release symlink", () => {
  for (const path of [
    "deploy/summate.service",
    "deploy/summate-runner.service",
    "deploy/summate-ash-seo.service",
  ]) {
    assert.match(asset(path), /\/opt\/summate-current\/dist\/src\//, path);
  }
});
