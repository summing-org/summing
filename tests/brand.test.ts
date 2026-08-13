import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

const root = process.cwd();
const excludedRoots = new Set([".agents", ".git", "dist", "node_modules"]);
const forbiddenIdentity = new RegExp(`(?:${"sum" + "mate"}|${"опо" + "ра"})`, "iu");

function productFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (directory === root && excludedRoots.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...productFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

test("SUMMING is the only product identity in repository assets", () => {
  for (const path of productFiles(root)) {
    const repositoryPath = relative(root, path);
    assert.doesNotMatch(repositoryPath, forbiddenIdentity, repositoryPath);
    assert.doesNotMatch(readFileSync(path, "utf8"), forbiddenIdentity, repositoryPath);
  }

  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  assert.equal(packageJson.name, "summing");
  assert.equal(packageJson.version, "9.0.0");
  assert.equal(readFileSync(join(root, "VERSION"), "utf8").trim(), "9.0.0");
  assert.match(readFileSync(join(root, "README.md"), "utf8"), /^# SUMMING 9\.0$/m);
});
