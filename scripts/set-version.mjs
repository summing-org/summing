import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const requested = process.argv[2] ?? "";
const semver = /^\d+\.\d+\.\d+$/;

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function write(path, value) {
  writeFileSync(resolve(root, path), value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

function versions() {
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));
  const source = read("src/version.ts").match(/SUMMING_VERSION = "([^"]+)"/)?.[1];
  const versionFile = read("VERSION").trim();
  const readme = read("README.md").match(/^# SUMMING (\d+\.\d+)/)?.[1];
  const handbook = read("PROJECT_HANDBOOK_RU.md").match(/^# SUMMING (\d+\.\d+)/)?.[1];
  return {
    package: packageJson.version,
    lock: packageLock.version,
    lockRoot: packageLock.packages?.[""]?.version,
    source,
    versionFile,
    readme,
    handbook,
  };
}

if (requested === "--check") {
  const current = versions();
  const expected = current.package;
  const minor = expected.split(".").slice(0, 2).join(".");
  const mismatches = Object.entries(current).filter(([name, value]) =>
    ["readme", "handbook"].includes(name) ? value !== minor : value !== expected
  );
  if (mismatches.length > 0) {
    throw new Error(`version mismatch: ${JSON.stringify(current)}`);
  }
  console.log(`SUMMING version files agree on ${expected}`);
  process.exit(0);
}

if (!semver.test(requested)) {
  throw new Error("usage: npm run release:version -- <major.minor.patch> or --check");
}

const packageJson = JSON.parse(read("package.json"));
const packageLock = JSON.parse(read("package-lock.json"));
packageJson.version = requested;
packageLock.version = requested;
packageLock.packages[""].version = requested;
write("package.json", `${JSON.stringify(packageJson, null, 2)}\n`);
write("package-lock.json", `${JSON.stringify(packageLock, null, 2)}\n`);
write("VERSION", requested);
write(
  "src/version.ts",
  read("src/version.ts").replace(/SUMMING_VERSION = "[^"]+"/, `SUMMING_VERSION = "${requested}"`),
);
const minor = requested.split(".").slice(0, 2).join(".");
write("README.md", read("README.md").replace(/^# SUMMING \d+\.\d+/m, `# SUMMING ${minor}`));
write(
  "PROJECT_HANDBOOK_RU.md",
  read("PROJECT_HANDBOOK_RU.md")
    .replace(/^# SUMMING \d+\.\d+/m, `# SUMMING ${minor}`)
    .replace(/^> Версия: \*\*[^*]+\*\*/m, `> Версия: **${requested}**`)
    .replace(/"version": "\d+\.\d+\.\d+"/, `"version": "${requested}"`),
);
console.log(`SUMMING version updated to ${requested}`);
