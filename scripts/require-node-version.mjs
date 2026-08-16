const minimumMajor = 24;
const currentVersion = process.versions.node;
const currentMajor = Number.parseInt(currentVersion.split(".")[0] ?? "", 10);

if (!Number.isSafeInteger(currentMajor) || currentMajor < minimumMajor) {
  console.error(
    `SUMMING requires Node.js ${minimumMajor}+; active runtime is ${currentVersion} (${process.execPath}).`,
  );
  console.error(
    "Activate the version from .node-version. In Codex, load workspace dependencies and prepend its Node bin directory to PATH.",
  );
  process.exit(1);
}
