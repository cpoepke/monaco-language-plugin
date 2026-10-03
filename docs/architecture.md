# Architecture

This project adds language-server code navigation to Monaco-based editors: go-to-definition across
files (Cmd/Ctrl+click, F12), Peek Definition/References, hover documentation, document symbols and
clickable document links. It supports TypeScript/JavaScript, Python, Go and Rust.

The first host is [Orca](https://github.com/stablyai/orca), an Electron agent IDE. Orca ships plain
`monaco-editor` without language-server support, and its plugin API has no way to reach the editor.
So the integration has two halves: an official Orca plugin runs the language servers, and a small
injected script wires them into Orca's editor.

```
┌──────────────── Orca renderer (file://, patched index.html) ────────────────┐
│  mlp/injector.js  (runs before Orca's bundle)                               │
│   1. traps MonacoEnvironment → globalAPI:true → captures `monaco`           │
│   2. window.api.plugins.invokeCommand('mlp.ensureBridge') → {port, token}   │
│   3. @mlp/monaco-lsp-client: providers, peek models, editor/link openers    │
│   4. Orca host adapter: open other files via the bridge, reveal the range   │
└───────────────┬─────────────────────────────────────────────────────────────┘
                │ ws://127.0.0.1:<port>/?token=…   (JSON-RPC 2.0, @mlp/protocol)
┌───────────────▼──────────────── Orca plugin worker (plain Node) ────────────┐
│  cpoepke.monaco-lsp  (dist/main.mjs, self-contained)                        │
│   @mlp/lsp-bridge: sessions per (server, workspace root), document refcounts│
│   spawns typescript-language-server / pyright / gopls / rust-analyzer       │
│   host navigator → Orca runtime RPC `files.open` (unix socket / pipe)       │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Packages

| Package                      | Runs in                   | Role                                                                                                                                                 |
| ---------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/protocol`          | both                      | Wire contract: method names, params/results, LSP allowlist, helpers.                                                                                 |
| `packages/lsp-bridge`        | Node                      | WebSocket server, language-server lifecycle, workspace-root detection, sandboxed file reads. Also a standalone CLI (`mlp-bridge`).                   |
| `packages/monaco-lsp-client` | browser                   | Host-agnostic Monaco integration. Takes the `monaco` namespace as a parameter and never imports it, so it works with whatever Monaco the host ships. |
| `packages/orca-plugin`       | Orca plugin worker        | Starts the bridge on demand, opens files in Orca through its runtime RPC.                                                                            |
| `packages/orca-injector`     | Orca renderer             | Captures Monaco, connects the client, reveals targets after Orca opens a tab.                                                                        |
| `packages/orca-patcher`      | user's machine (CLI)      | `npx monaco-lsp-orca install`: adds the injector to Orca's `app.asar`, installs the plugin folder.                                                   |
| `packages/orca-patch-core`   | CLI + Orca plugin worker  | The patch itself (inspect, anchor check, inject, repack, backup, atomic replace, lock, config, macOS signing, deferred swap), bundled by both.       |
| `apps/demo`                  | browser + Vite dev server | Standalone test bed: file tree, Monaco and the real bridge. Playwright e2e for all four languages.                                                   |

## Key decisions

- **Own thin LSP client rather than `monaco-languageclient`.** TypeFox's client requires replacing
  `monaco-editor` with `@codingame/monaco-vscode-api`, which a host like Orca cannot do. Monaco's
  built-in `monaco.lsp` client is alpha, sends `rootUri: null`, and fails on locations in unopened
  files. The bridge owns the LSP handshake; the browser only opens documents and forwards an
  allowlist of read-only requests.
- **Reuse from upstream.** Orca has open, unmerged LSP pull requests (#14873, #24703). Their
  MIT-licensed code is vendored in `vendor/orca-lsp/` and adapted, with attribution.
- **Peek models use their own URI scheme (`mlp-peek:`).** Peek and Ctrl+hover previews need a model
  for every result. Creating `file://` models would collide with the host's own models (Orca
  disposes them when tabs close), so previews of unopened files get read-only `mlp-peek:` models.
  Opening one goes through the host adapter with the real `file://` URI.
- **Visible models only.** Hosts create many background models (diffs, notebooks, excerpts). The
  client attaches only `file:` models shown in an editor.
- **Monaco's built-in TS navigation is replaced, not stacked.** The client turns off the TS worker's
  definitions/references/hovers/symbols up front and answers them itself, falling back to the TS
  worker when no bridge session exists, so results are never shown twice.
- **Security.** The bridge listens on loopback only, requires a random token and refuses
  WebSocket handshakes with a foreign `Origin` or a non-loopback `Host`. Only navigation requests
  are forwarded (no `executeCommand`, edits or configuration changes). With `allowedRoots` set
  (fixed `--root`s, or a function the embedder evaluates on every open and read; the Orca
  plugin passes Orca's worktree roots), documents and file reads outside those roots are
  refused, and a provider that cannot answer refuses everything. Without it, reads are confined
  to the roots of sessions the client opened. Session roots are never the filesystem root, the
  home directory or above it, and only existing local files (no UNC hosts) can be opened.
  Server binaries come from absolute `PATH` entries and fixed dirs and are spawned by absolute
  path; binaries in a project's `node_modules/.bin` run only when explicitly trusted
  (`--trust-project-binaries`).
- **Results use the client's paths.** Servers see realpaths; result URIs under a symlinked root
  are rewritten back to the spelling the client opened the document with.
- **Cancellation.** `lsp/cancel {id}` sends `$/cancelRequest` for the client's pending
  `lsp/request` with that JSON-RPC id, which then fails with `-32800` (LSP RequestCancelled).
- **Watched files.** Servers that register `workspace/didChangeWatchedFiles` watchers (gopls,
  rust-analyzer) get created/changed/deleted events from one watcher per session root.

## Surviving Orca updates

Orca's updater replaces `app.asar`, so the injected `<script>` disappears with every update, while
the plugin folder in Orca's userData stays. The plugin therefore repairs the patch itself:

```
Orca update → new app.asar (no injector) → Orca starts → agent.status.changed / worktree event
  → Orca starts the plugin worker (manifest event) → activate → +1.5 s: self-repair check
     execPath (Orca's binary) → <resources>/app.asar → package.json name === "orca"?
     inspect: patched? injector version? Monaco anchor?
     lock app.asar.mlp-lock → back up the new pristine archive → build the patched archive
     → rename over app.asar ─ ok ──────────────→ notify "… Restart Orca to activate it."
                            ├ EBUSY/EPERM (Win) → app.asar.mlp-pending + detached helper
                            │                     (waits for Orca to exit, renames, verifies)
                            └ EACCES/EROFS ────→ notify `sudo monaco-lsp-orca install --app …`
```

- **One implementation.** The CLI and the plugin bundle the same `@mlp/orca-patch-core`, and the
  plugin folder ships the injector (`assets/injector.js`) it installs. Both take the same O_EXCL
  lock next to the archive, so they never patch concurrently.
- **Electron's fs.** Inside Orca the worker runs with `ELECTRON_RUN_AS_NODE`, where `fs` still
  treats `app.asar` as a directory. The core switches to Electron's built-in `original-fs` there.
- **Safe while Orca runs.** On macOS and Linux the running Orca keeps the old archive's inode open,
  so renaming a new `app.asar` over it is safe and takes effect on the next start. Windows refuses
  the rename while Orca has the file open; the patched archive then waits next to it and a
  detached helper (Orca's binary in Node mode, `dist/apply-pending.mjs`) swaps it in after Orca's
  main process exits, after checking that `app.asar` is still the one it was built from.
- **Opt-out and signing.** `~/.monaco-lsp-orca/config.json` (`autoRepair`, `resign`) is written by
  the CLI; `uninstall` turns `autoRepair` off. On macOS the repair re-signs ad hoc unless
  `resign` is false (`install --no-resign`).
- **Pure decisions.** What to do for which archive state, and the text of every notification, is
  a pure function (`packages/orca-plugin/src/self-repair/decide.ts`); the e2e suite simulates an
  update in `apps/orca-sim` (`e2e/auto-repair.spec.ts`).

## Orca integration facts

Verified details (how Monaco is captured, the runtime RPC shape, plugin worker lifecycle, URI
schemes and reveal timing) are in [`spikes.md`](./spikes.md).
