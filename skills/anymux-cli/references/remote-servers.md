<!-- plugin-capability: servers -->
# Multi-Server Routing

AnyMux Hub relays machine-scoped API calls (`/api/workspace`, `/api/worktrees`, `/api/automations`, `/api/session-vault`, `/api/open`, `/api/git`, `/api/browser`, `/api/node/info`) through `/n/:serverId/*`.

## Commands

```text
ANYMUX server list [--json]
ANYMUX status --server <id> --json
ANYMUX workspace list --server <id> --json
```

## Rules & Auth Isolation

- Set `--server <id>` (or `ANYMUX_SERVER=<id>`) on any node-scoped command to target a paired remote server.
- Hub routes (`/api/servers` and `/n/:serverId/...`) never accept the local node pairing token (`node.json`). On loopback Hub access without auth or with `trustLocal` enabled, requests succeed automatically; otherwise set `ANYMUX_AUTH_TOKEN` to a Hub login Bearer token.
- Hub-only and local-only commands (`server list`, `agent-context`, `skills install|update`, `split`, `run`, `capture`, `events`) refuse non-local `--server` targets.
<!-- /plugin-capability -->
