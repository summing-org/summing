- [Finish Commands](.agents/feedback_finish_commands.md) — after every work-item run commands.
- [Maintain changelog fragments on every summary](.agents/feedback_changelog.md) — after every meaningful work-item summary, append it to `.changes/${UTC-date}.md`; `CHANGELOG.md` stays an index.
- [Isolate agent worktrees](.agents/feedback_worktree_isolation.md) — agents work only in their own git worktree and never switch or mutate the user's main `master` checkout.
- [Worktree git flow](.agents/feedback_worktree_git_flow.md) — after each iteration: commit, rebase on `master`, report the ready branch/SHA, ask whether to run `git merge --ff-only <branch>` from the main worktree, and merge only after explicit approval. Never push to origin (user does it manually).

