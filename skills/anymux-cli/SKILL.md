---
name: anymux-cli
description: >-
  Operate AnyMux workspaces, tmux sessions/windows/panes, rich panes (browser,
  diff, doc), Git worktrees, session archives, scheduled automations, side-panel
  file/commit previews, and multi-server routing (`--server <id>`) through the
  `anymux` CLI. Use when the user mentions `$anymux-cli`, asks to inspect or
  manage AnyMux workspaces/panes/worktrees/automations/sessions, route commands
  to a paired server, or discover AnyMux CLI commands (`agent-context`, `status`).
  For writing and docking long Agent documents, also follow `agent-docs`; for
  installing or maintaining the AnyMux panel itself, use `anymux`; for MCP
  interactive pane jobs when available, use `tmux-agent`.
---

# AnyMux CLI

This discovery stub loads the version-matched guide from the `anymux` CLI used for this session.

## Resolve the CLI for this session

Choose the executable once and reuse it for every later command:

1. If `ANYMUX_CLI_COMMAND` is set, use its value.
2. Otherwise, if global instructions (`AGENTS.md` / `CLAUDE.md`) name the panel CLI (such as `node ".../bin/anymux.mjs"`), use that exact command.
3. Otherwise, use `anymux`.

Below, `ANYMUX` is a placeholder for the executable you resolved. Substitute it before running; do not silently switch to a different checkout or release build.

## Load the version-matched guide before running commands

```text
ANYMUX skills get anymux-cli
```

Prefer `--json` for agent-driven calls so responses use `{ ok, data }` and `{ ok: false, error: { code, message, nextSteps } }`.
Run `ANYMUX agent-context --json` when you need the exact machine-readable command list, flags, and examples.

When a command fails:
- Follow `error.nextSteps` strictly (for example `preview_source_ambiguous` / `preview_source_untrusted` gives `--pane %N`, and `panel_unavailable` means the panel service is offline—do not spin in a tight retry loop).
- If `skills get` is unknown on an older CLI binary, run `ANYMUX --help` and do not guess unsupported flags.
