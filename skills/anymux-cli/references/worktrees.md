<!-- plugin-capability: worktrees -->
# Git Worktrees

Manage parallel Git worktrees with monorepo `sharedDirectories` symlinking (`.anymux/worktrees.json`, `anymux.json`, or `orca.json`) and dirty/active-pane safety guards.

## Commands

```text
ANYMUX worktree list [--repo <dir>] [--server <id>] [--json]
ANYMUX worktree new <branch> [--repo <dir>] [--base <ref>] [--open] [--server <id>] [--json]
ANYMUX worktree remove <path> [--repo <dir>] [--force] [--server <id>] [--json]
```

## Rules

- `worktree new` creates a new branch checkout under `../.anymux-worktrees/<repo>/<slug>` and links configured `sharedDirectories` without overwriting existing paths.
- Pass `--open` to open a new tmux window in that worktree automatically.
- `worktree remove` rejects dirty worktrees or worktrees with active AnyMux panes unless `--force` is passed. Confirm with the user before forcing removal of uncommitted work.
<!-- /plugin-capability -->
