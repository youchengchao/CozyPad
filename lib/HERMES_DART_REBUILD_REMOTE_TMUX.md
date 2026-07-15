# Hermes Dart Rebuild — Remote tmux Control Plane

This build removes consumer messaging gateways from the product direction and replaces them with a VS Code / Claude Code style remote-control model.

## Local app responsibilities

- Owns the Dart-native Hermes harness loop.
- Owns provider calls, tool registry, approval policy, local memory, local skills, and local session persistence.
- Uses SSH as the remote execution transport.

## Remote server responsibilities

The app can bootstrap a lightweight runtime under:

```text
~/.ssh_dashboard/
├─ bin/sdh-probe
├─ logs/
├─ sessions/
├─ tmux_meta/
├─ skills/
└─ tools/
```

The server is allowed to have installed tools, but the user operates them from the Windows exe / app.

## Persistent mode

The harness now exposes these tools:

- `remote.bootstrap`
- `remote.tmux.list`
- `remote.tmux.start`
- `remote.tmux.send`
- `remote.tmux.capture`
- `remote.tmux.stop`

Dashboard-managed tmux sessions are prefixed with `sdh_` and survive local app disconnects. Another desktop/mobile client can reconnect over SSH, list sessions, capture the pane, and continue sending input.

## Gateway decision

Discord/Telegram/Slack/WhatsApp-style message gateways are intentionally not carried over. The replacement entry point is this app's remote-control plane.
