# control-terminal

The workbench uses `pool` / `/ws/window-stream/:windowId`: a single persistent
tmux control-mode connection per server instance multiplexing binary output
and snapshot frames for every pane in a window, paired with the Seam tiling
frontend (`plugins/workbench/client/`). `windowStream` reports
`{ available, protocol: 1, binary: true }` once tmux supports native pane
snapshots (`#{pane_snapshot_version}`). `controlTerminal` keeps reporting raw
`/ws/pane-stream/:paneId` snapshot support for compatibility.
