---
name: Worktree git flow (commit → rebase → ask before ff-merge)
description: How to finish a completed iteration from an isolated worktree branch. The agent commits, rebases, reports the ready branch/SHA, and asks before running the fast-forward merge from the user's main worktree.
type: feedback
---
After finishing a unit of work on an isolated worktree branch (`codex/...` or
another task branch):

1. Commit the work on the task branch.
2. `git rebase master` from the task worktree. Local `master` should already be
   fresh because each iteration starts with `git fetch origin --tags
   --prune-tags`.
3. Resolve conflicts if any, then `git rebase --continue`.
4. Run tests / typecheck if the rebase brought in conflicts or non-trivial
   changes; optional on a clean ff-rebase.
5. Report the branch name, commit SHA, and one-line summary.
6. Ask the user exactly: "Могу ли я сделать `git merge --ff-only <branch>` в
   твоём основном worktree?"
7. If the user does not explicitly approve, stop; the branch remains ready for
   later integration.
8. If the user explicitly approves, inspect `git worktree list`,
   `git -C <main-worktree> branch --show-current`, and
   `git -C <main-worktree> status --short`. If the main worktree is not on
   `master`, stop immediately and report the current branch and status to the
   user. Do not switch branches or otherwise modify that checkout.
9. Only if the main worktree is on `master`, clean, and no merge/rebase is in
   progress, run
   `git -C <main-worktree> merge --ff-only <branch>`.
10. Do not move `refs/heads/master` from the task worktree and never push to
   origin.

**If integration is blocked.** If the main worktree is dirty or another
integration is in progress, or if the main worktree's current branch is not
`master`, stop and report that the user must resolve that state first.

**Why this boundary exists.** Earlier flow ended with `git checkout master &&
git merge --ff-only` or — worse — `git update-ref refs/heads/master HEAD
<prev>` from the feature worktree. The first fails because master is checked
out elsewhere; the second silently moves the branch pointer but **leaves the
main worktree's index and working tree on the previous commit**, making `git
status` over there show every changed file as "modified" (phantom diff between
old index and new HEAD). Recovery requires `git reset --hard HEAD` in the main
worktree, which is destructive if the user had unstaged work there.

**Master lives in the user's main worktree.** Do not move it from the feature
worktree. The main checkout is a user-owned integration surface, and parallel
agents must not compete for it. The approval gate is still required so only
one agent integrates through the main checkout at a time.

**Never push to origin.** Publication is a manual gate owned by the user.
