## Use the repository Node runtime

SUMMING requires Node.js 24 or newer and imports `node:sqlite`. The host may also
have an older system Node in `PATH`; do not use it for repository commands.

Before the first `npm`, `make build`, `make test`, or `make lint` command in an
iteration:

1. Run `node --version`.
2. If the major version is below 24, load the Codex workspace dependencies and
   prepend the returned Node `bin` directory to `PATH` for every repository
   command in that shell.
3. Confirm `node --version` reports 24 or newer before starting a long command.

The repository's `.node-version` is the source for local version managers.
Lifecycle commands also run `scripts/require-node-version.mjs` and fail before
compilation when the active runtime is too old. Treat that failure as an
environment-selection error; switch runtimes instead of interpreting partial
test output or changing application code.
