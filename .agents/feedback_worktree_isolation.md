---
name: Isolate agent worktrees
description: Agents must do task work in their own git worktree so parallel agents never mutate the user's main master checkout.
type: feedback
---

Agents must treat the user's main repository checkout as an integration
surface, not as a place to do task work.

## Core rule

- The main checkout where `master` is checked out belongs to the user.
- Agents do not run task edits, rebases, merges, or branch switches in that
  checkout.
- Each active agent works in its own dedicated `git worktree` on its own task
  branch, normally named `codex/<short-task-name>`.
- Parallel agents must never share a working tree. Sharing a repository object
  database is fine; sharing the checkout, index, or current branch is not.

## Starting a task

1. Run `git fetch origin --tags --prune-tags` before starting a new iteration.
2. Inspect `git status --short` and `git branch --show-current`.
3. If the current checkout is the user's main checkout but the current branch
   is not `master`, stop immediately. Do not switch branches, edit files,
   stage, commit, rebase, merge, or try to "clean up" that checkout. Report
   the current branch and `git status --short` output to the user and wait for
   explicit direction.
4. If the current checkout is the user's main checkout on `master`, create or
   switch to a dedicated worktree before editing files.
5. Prefer worktree paths outside the main checkout, for example:
   `/Users/pav/summing/summate.worktrees/codex-short-task-name`.
6. Create the task branch from fresh local `master`:
   `git worktree add -b codex/<short-task-name> <path> master`.
7. Before linking dependencies, verify that the shared install is populated:
   `test -x /Users/pav/summing/summate/node_modules/.bin/tsc`. If it is
   missing, first confirm that the main checkout is on `master` and has no
   tracked changes, then run `npm ci --no-audit --no-fund` once from
   `/Users/pav/summing/summate`. This is the only allowed dependency-cache
   write in the main checkout; it must not change tracked files.
8. Immediately after creating the worktree, create only a `node_modules`
   symlink that points at the populated main checkout dependencies:
   `ln -s /Users/pav/summing/summate/node_modules node_modules`.
   Run this command from the new worktree root. This lets build/test write
   `dist` locally in the isolated worktree while reusing the existing
   dependency install instead of mutating the user's main checkout.
9. Never run `npm install` or `npm ci` in a worktree while `node_modules` is
   this symlink, because the command would mutate the shared main dependency
   install. If a task changes `package.json` or `package-lock.json`, run
   `unlink node_modules` and install worktree-local dependencies instead.
10. Continue all task commands from the dedicated worktree path.

If a dedicated worktree for the same task already exists, use it after
checking its status. Do not delete or reset it unless the user explicitly asks.

## Forbidden in the main checkout

Do not run these from the user's main checkout unless the user explicitly asks
for that exact integration or maintenance action:

- `git switch ...`
- `git checkout ...`
- `git merge ...`
- `git rebase ...`
- `git reset ...`
- file edits for a task branch

The one-time ignored `node_modules` bootstrap in Starting a task step 7 is the
only standing exception. It is dependency-cache maintenance, not task work.

Read-only inspection commands such as `git status`, `git worktree list`,
`git log`, `rg`, and `sed` are allowed in the main checkout.

## Why

The main checkout has one mutable index, working tree, and current branch.
When two agents both try to use it, one agent's `git switch`, rebase, merge, or
index update can invalidate the other agent's active context. Dedicated
worktrees keep branch state and file edits isolated while still sharing the
same git object database.

## Integration boundary

At the end of a task, the agent prepares a rebased branch, reports it, and
asks whether to run the fast-forward merge from the user's main worktree. The
user decides when to integrate branches into `master`. An agent may perform
the final fast-forward merge only after the user explicitly approves that
integration action.
