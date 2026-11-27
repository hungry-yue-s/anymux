<!-- plugin-capability: automations -->
# Scheduled Automations

Inspect and manually trigger AnyMux's cron-scheduled automations on the local panel or a paired remote node.

## Commands

```text
ANYMUX automation list [--server <id>] [--json]
ANYMUX automation run <id> [--server <id>] [--json]
```

## Rules

- Run `automation list --json` to discover job IDs, cron schedules, `target` (`shell` vs `new-window`), and recent `runs`.
- Triggering `automation run <id>` is stateful and executes the job command immediately; run it only when requested or required for verification.
<!-- /plugin-capability -->
