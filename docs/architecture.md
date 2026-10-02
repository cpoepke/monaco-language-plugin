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
- **Security.** The bridge listens on loopback only and requires a random token. Only navigation
  requests are forwarded (no `executeCommand`, edits or configuration changes). File reads are
  confined to session roots. Binaries in a project's `node_modules/.bin` run only when explicitly
  trusted (`--trust-project-binaries`).

## Orca integration facts

Verified details (how Monaco is captured, the runtime RPC shape, plugin worker lifecycle, URI
schemes and reveal timing) are in [`spikes.md`](./spikes.md).
