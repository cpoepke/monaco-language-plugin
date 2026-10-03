# Code Navigation (LSP) for Orca

An [Orca](https://github.com/stablyai/orca) plugin (`cpoepke.monaco-lsp`) that runs language
servers for Orca's Monaco editor: go to definition, find references, hover and document links
for **TypeScript/JavaScript, Python, Go and Rust**.

The plugin's worker hosts the `@mlp/lsp-bridge` WebSocket bridge on `127.0.0.1` and starts the
language servers that are already installed on your machine. The editor side (the injector
script added to Orca's renderer by the patcher) asks the plugin for a connection and talks to
the bridge directly. When you jump to another file, the bridge asks Orca to open it through
Orca's local runtime RPC (`files.open`), so the file opens as a normal Orca tab.

> Orca's plugin system is **experimental**. This plugin targets plugin API 1 and Orca
> `>=1.4.214`.

## Install

1. Build the installable folder from the repository root:
   ```sh
   pnpm install
   pnpm --filter @mlp/orca-plugin run pack
   ```
   This writes `packages/orca-plugin/release/cpoepke.monaco-lsp/`, which contains
   `orca-plugin.json`, `dist/main.mjs`, `README.md` and `LICENSE`. `dist/main.mjs` is
   self-contained, so no `node_modules` is needed.
2. In Orca, open **Settings → Plugin system** and turn the plugin system on.
3. Install the folder, using either method:
   - **Install plugin → Local folder**, then enter the full path to
     `release/cpoepke.monaco-lsp`. Orca copies the folder into
     `<userData>/plugins/cpoepke.monaco-lsp/<hash>/`.
   - **Development → Development plugin folder path**, then add the same folder. Orca loads it in
     place, which is handy while you work on the plugin.
4. Review the permissions (_Show desktop notifications_, _Subscribe to events_) and choose
   **Enable plugin**.
5. Install the language servers you want (see below) and run the renderer patcher, so the
   editor actually uses the plugin.

## Commands

The renderer calls each command with
`window.api.plugins.invokeCommand({ pluginKey: 'cpoepke.monaco-lsp', commandId, args })`. They
also appear in Orca's command list.

| Command            | Title                                    | Returns                                                                                   |
| ------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `mlp.ensureBridge` | Language Servers: Start / Get Connection | `{ port, token, protocolVersion, pluginVersion, hostNavigation }`                         |
| `mlp.status`       | Language Servers: Status                 | `{ running, port, protocolVersion, pluginVersion, hostNavigation, bridge, idleStopInMs }` |
| `mlp.restart`      | Language Servers: Restart                | the same as `mlp.ensureBridge`, with a new port and token                                 |
| `mlp.stop`         | Language Servers: Stop                   | `{ stopped: boolean }`                                                                    |

- `mlp.ensureBridge` starts the bridge the first time it is called (ephemeral port, random
  32-byte hex token). Later calls return the same values while the bridge runs. Connect to
  `ws://127.0.0.1:<port>/?token=<token>`. `hostNavigation` is `true` when Orca's runtime metadata
  (`orca-runtime.json`) was found, which means cross-file jumps can open real Orca tabs.
- `mlp.status` shows a notification with a summary (installed and missing servers). Pass
  `{ silent: true }` as args to skip the notification. `bridge` is the bridge's `BridgeStatus`,
  or `null` when stopped.

### Lifecycle and the heartbeat

Orca starts the plugin worker on the first command and **reaps it after 5 minutes without
plugin activity**. That kills the bridge and all language servers. Only command calls, event
acks and host calls count as activity; WebSocket traffic does not. So the renderer injector
calls `mlp.ensureBridge` about **every 2 minutes** as a heartbeat. Each call keeps the worker
alive, and its result tells the injector to reconnect if the worker restarted with a new port.

The plugin also stops the bridge on its own (closing servers, while the worker stays up) after
**10 minutes with no connected client and no heartbeat**. The next `mlp.ensureBridge` starts it
again.

On shutdown, Orca sends a `shutdown` message and the plugin's `deactivate` closes the bridge
within ~1.5 s. Orca SIGKILLs the worker 2 s after sending it. If closing takes too long, or the
process exits by another path (IPC disconnect, SIGTERM), the plugin synchronously sends SIGTERM
to every language server's process group, so helpers they started (tsserver, gopls workers) go
too. That includes servers that are still in the middle of shutting down.

## Language servers

None are bundled. The bridge uses the first one it finds:

| Language                | Server (in order of preference)                 | Install, for example                             |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------ |
| TypeScript / JavaScript | `typescript-language-server`, `tsgo`            | `npm i -g typescript typescript-language-server` |
| Python                  | `pyright-langserver`, `basedpyright-langserver` | `npm i -g pyright` / `pipx install basedpyright` |
| Go                      | `gopls`                                         | `go install golang.org/x/tools/gopls@latest`     |
| Rust                    | `rust-analyzer`                                 | `rustup component add rust-analyzer`             |

Binaries shipped inside the opened project (`node_modules/.bin`) are **never** run, because
opening a file in an untrusted repository must not execute its code.

## Troubleshooting

- **"Not found" for a server you installed.** When Orca is started from the Dock or Finder on
  macOS (or from a desktop entry on Linux), it gets a minimal `PATH`, and plugin workers only
  inherit that. Before the first start, the plugin appends the directories that exist among
  these: `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/go/bin`, `~/.cargo/bin`,
  `~/.volta/bin`, `~/.bun/bin`, `~/.npm-global/bin`, pnpm/mise/asdf/fnm shims, and the newest
  `~/.nvm` Node. On Windows it uses `%USERPROFILE%\AppData\Roaming\npm`, `go\bin`, `.cargo\bin`,
  and others. Node-based servers also need `node` on that `PATH`. If yours lives elsewhere,
  symlink the server into one of those directories. The effective list is printed in Orca's
  plugin log (`extended PATH …`, `language servers {found, missing}`), and also by
  **Language Servers: Status**.
- **Cross-file jumps open a peek instead of a tab.** Orca can only open files that are inside
  one of its worktrees, so library files (for example `node_modules/…/lib.d.ts`) always stay in
  the peek view. Targets outside every worktree (a globally installed library, `~/.cargo`
  sources) cannot be previewed at all, because the bridge only reads inside worktrees. If
  navigation does not work for files inside your project either, the plugin could not find
  `orca-runtime.json`: without the runtime it cannot learn the worktree roots and serves no
  files. An installed plugin finds it three directories above its own folder.
  A development plugin falls back to `~/Library/Application Support/orca` (macOS),
  `~/.config/orca` (Linux) or `%USERPROFILE%\AppData\Roaming\orca` (Windows). `orca-dev` is tried
  as well. Outside Orca, set `MLP_ORCA_USER_DATA` to point at the right directory.
- **Nothing happens at all.** Check that the plugin system is on and the plugin is enabled and
  approved, then run **Language Servers: Status**.

## Security

- The bridge listens on **127.0.0.1 only**, on a random ephemeral port.
- Every WebSocket connection must present a **random 32-byte token**, which is new for each
  bridge start. Only Orca's renderer receives it, through the plugin command. It is redacted
  from the plugin's log lines. Handshakes from web pages are refused before the token is even
  compared: the `Origin` must be absent, `null`, `file://` (Orca's renderer) or a loopback
  http(s) page, and the `Host` header must name a loopback address (no DNS rebinding).
- **Files are confined to Orca's worktrees.** The bridge opens documents and serves file reads
  (for peek views) only inside the worktree roots that Orca's runtime reports (`worktree.list`,
  realpath'd, cached for 10 s, refreshed when a file falls outside them and on
  `worktree.created` / `worktree.removed`). A removed worktree stops being readable right away.
  If the runtime cannot be reached, only roots that were already known stay allowed; if it was
  never reachable, nothing is served (fail closed). Files that do not exist and `file:` URIs
  naming another host (UNC paths) are refused.
- A language server is never started for the filesystem root, your home directory or a
  directory above it, even when a stray `~/package.json` or `~/.git` exists: the nearest project
  marker below home wins. The session root is also the limit for what the bridge reads.
- Clients can only forward an **allowlist of read-only LSP requests** (definition, declaration,
  type definition, implementation, references, hover, document symbols, document links,
  diagnostics). Nothing that edits files or runs commands is forwarded.
- Server binaries are looked up in `PATH` (absolute entries only; `.` and relative entries are
  skipped), `~/go/bin` and `~/.cargo/bin`, and are always spawned by absolute path without a
  shell. Binaries shipped inside the opened project are never run.
- The Orca runtime auth token from `orca-runtime.json` (a 0600 file) is used only to call
  `worktree.list` and `files.open`. It is never logged.
- The plugin asks for two Orca capabilities: `notifications:show` (the status summary) and
  `events:subscribe` (worktree created/removed, to keep the allowed roots current). Orca's
  permission dialog states it plainly: like any plugin worker, this one runs as a normal process
  with your user's permissions.

## Development

```sh
pnpm --filter @mlp/orca-plugin typecheck
pnpm --filter @mlp/orca-plugin build    # dist/main.mjs (ESM, node22, everything inlined)
pnpm vitest run packages/orca-plugin    # includes a smoke test that runs the built bundle in a bare node process
pnpm --filter @mlp/orca-plugin run pack     # release/cpoepke.monaco-lsp/
```

Source layout: `main.ts` (entry), `plugin-controller.ts` (commands, idle stop, shutdown),
`bridge-host.ts` (the only module that imports `@mlp/lsp-bridge`), `orca-runtime-client.ts`
(NDJSON runtime RPC), `host-navigator.ts` and `worktree-paths.ts` (`files.open` mapping),
`orca-user-data.ts`, `server-path.ts`.
