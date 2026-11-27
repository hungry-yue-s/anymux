<!-- plugin-capability: workbench -->
# Rich Panes (Workbench)

AnyMux's single-layer workbench supports mixing terminal panes and rich tiles (`browser`, `diff`, `doc`, etc.) inside the same tmux window layout.

## Commands

```text
ANYMUX pane open <kind> [--payload <json> | --url <url> | --path <path>] [--label <label>] [--dir h|v] [--window @id] [--pane %N] [--server <id>] [--json]
ANYMUX pane set-kind <kind> [--payload <json> | --url <url> | --path <path>] [--pane %N] [--server <id>] [--json]
```

## Rules

- `--url` and `--path` merge cleanly into `--payload` JSON; you do not need to hand-escape JSON for simple URL or file panes.
- To restore a rich pane back to an interactive terminal, run `ANYMUX pane set-kind terminal --pane %N`.
- `pane open` requires `--window @id` (or defaults to the first window of the first session if omitted). Inspect `workspace list --json` first to pick the exact window and pane IDs.
<!-- /plugin-capability -->
