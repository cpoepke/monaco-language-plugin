# monaco-language-plugin

Language-server code navigation for Monaco-based editors. In the editor you can:

- **Cmd/Ctrl+click or F12** to jump to a definition, including in other files.
- **Peek Definition / Peek References** to preview other files inline.
- **Hover** to see documentation and signatures from the language server.
- Use **document symbols** (Quick Outline) and **clickable document links**.

Supported languages: **TypeScript/JavaScript, Python, Go, Rust**. Each uses the real language
server installed on your machine.

The first host is [**Orca**](https://github.com/stablyai/orca), the agent IDE. Orca has no
language-server support today, so you can open a file from your own codebase and click through
its symbols. A host-agnostic client library and a standalone demo are included as well.

> **Status:** v0.1, experimental. Tested end to end against a high-fidelity Orca simulation
> (`apps/orca-sim`: Orca's bundler and Monaco setup, the real patcher, the real plugin in an Orca-
> style worker, a fake Orca runtime) and real language servers, but **not yet against a real
> Orca install**. Upstream Orca has open,
> unmerged LSP pull requests (#14873, #1912, #24703). If one lands, this integration should be
> retired.

## How it works with Orca

Orca's plugin API cannot reach its editor, so the integration has two parts:

1. **An Orca plugin (`cpoepke.monaco-lsp`).** It runs the language servers in Orca's plugin
   worker and opens files in Orca tabs through Orca's local runtime API.
2. **A small injected script.** `monaco-lsp-orca install` adds one `<script>` tag to
   Orca's `app.asar`. The script connects Orca's Monaco editor to the plugin over
   `ws://127.0.0.1` with a random token.

See [`docs/architecture.md`](docs/architecture.md) for the design and
[`docs/spikes.md`](docs/spikes.md) for the verified Orca internals it relies on.

## Install (Orca)

Prerequisites: Node ≥ 22, pnpm, Orca ≥ 1.4.214, and the language servers you want:

| Language | Server                                              | Install                                          |
| -------- | --------------------------------------------------- | ------------------------------------------------ |
| TS/JS    | `typescript-language-server` (or `tsgo --lsp`)      | `npm i -g typescript-language-server typescript` |
| Python   | `pyright-langserver` (or `basedpyright-langserver`) | `npm i -g pyright` or `pip install pyright`      |
| Go       | `gopls`                                             | `go install golang.org/x/tools/gopls@latest`     |
| Rust     | `rust-analyzer`                                     | `rustup component add rust-analyzer`             |

```sh
git clone https://github.com/cpoepke/monaco-language-plugin
cd monaco-language-plugin
pnpm install && pnpm build

# Quit Orca first. Use sudo for /opt installs on Linux.
node packages/orca-patcher/dist/cli.js doctor    # which language servers were found AND work (runs their version command)
node packages/orca-patcher/dist/cli.js install   # patch Orca + copy the plugin folder
```

Then, one time only, in Orca:

1. **Settings → Plugins:** turn on the experimental plugin system.
2. **Install plugin → Local folder:** choose `~/.monaco-lsp-orca/plugin/cpoepke.monaco-lsp`. The
   installer prints the exact path.
3. Review the two permissions (show notifications, subscribe to events) and **enable** the
   plugin.
4. Restart Orca and open a `.ts`, `.py`, `.go` or `.rs` file, then Cmd/Ctrl+click a symbol.

Other commands:

- `status`: is Orca patched? Did an update remove the patch? Signing mode and auto-repair setting.
- `uninstall`: restores the original `app.asar` from the backup and turns auto-repair off.
  `--purge` also removes the plugin folder.
- `install --no-auto-repair`: don't let the plugin re-patch Orca after updates.
- `install --no-resign` (macOS): keep Orca's Developer ID signature, see below.
- `--app <path>`: point at a non-default install. Accepts `Orca.app`, the install dir,
  `resources/` or an extracted AppImage `squashfs-root`.

### Caveats

- **Orca updates remove the patch; the plugin puts it back, and you restart once.** The plugin
  folder survives updates. Soon after Orca starts (Orca wakes the plugin on the first agent
  status change or worktree event), the plugin notices that the update removed the injected
  script, patches the new `app.asar` itself, and shows _"Code navigation was
  re-enabled after the Orca update (vX). Restart Orca to activate it."_ What you see per OS:
  - **macOS, Linux installs your user can write to (e.g. an extracted AppImage):** the patch is
    applied right away; restart Orca once. On macOS the app is re-signed as after `install` (unless you chose
    `--no-resign`).
  - **Windows:** a running Orca keeps `app.asar` locked, so the patched copy is parked next to
    it and a small helper swaps it in when you quit Orca. The next start has code navigation.
  - **Read-only installs** (deb/rpm under `/opt` owned by root, a mounted AppImage): the
    notification gives the exact command, e.g. `sudo monaco-lsp-orca install --app "/opt/Orca"`.
  - **A new Orca version without the Monaco anchor:** _"This Orca version (x.y.z) isn't
    supported by Code Navigation yet"_, and nothing is changed.

  **Language Servers: Repair Orca Patch** runs the same check on demand. Turn the automatic
  repair off with `install --no-auto-repair` (`~/.monaco-lsp-orca/config.json`).

- **macOS signing:** by default the app is ad-hoc re-signed after patching, which replaces
  Orca's Developer ID signature. Expect keychain/privacy prompts again. Auto-update may refuse
  until you reinstall Orca from the official download, which is also the only way to restore the
  original signature. `install --no-resign` keeps the Developer ID signature instead (see
  [Testing on macOS](#testing-on-macos)).
- **Linux AppImage** is read-only: extract it (`--appimage-extract`), patch `squashfs-root`
  with `--app`, and launch via `AppRun`.
- **Not supported yet:** remote/SSH worktrees. The editor stays read-only for navigation:
  there is no completion, rename or code actions.
- **GUI-launched Orca has a minimal `PATH`.** The plugin also searches Homebrew, `/usr/local`,
  `~/.local/bin`, `~/go/bin`, `/usr/local/go/bin` and `~/.cargo/bin`. gopls also needs `go`
  itself on that path. Servers installed elsewhere (custom toolchain dirs, version managers
  that rely on shell init) may not be found; `doctor` shows what is detected and flags servers that exist but fail to run
  (`broken`, e.g. a rustup `rust-analyzer` proxy without the component) with a fix.
- **First results can be slow.** tsserver and rust-analyzer take ~10 s to load a project. Until
  then, TypeScript may only resolve same-file symbols.
- In Peek, **double-click** a result to open the file. Enter only previews it (standalone
  Monaco behaviour).
- Set `localStorage['mlp.disabled'] = '1'` in Orca's devtools to turn the injector off, or
  `localStorage['mlp.debug'] = '1'` to turn on logging.

### Testing on macOS

Neither signing mode has been tried on a real Mac yet. If you can, please try `--no-resign`
first and report back:

```sh
node packages/orca-patcher/dist/cli.js install --no-resign
node packages/orca-patcher/dist/cli.js status        # shows the signing mode + codesign --verify
```

1. Does Orca launch (also after a reboot)? Does Code Navigation work?
2. When the next Orca update arrives, does the auto-update install? After the restart, does the
   plugin re-enable code navigation (one more restart)?
3. Any keychain or privacy prompts?

`--no-resign` keeps Orca's Developer ID signature, so its code identity is unchanged and
auto-update should keep working, but the resource seal no longer matches the modified `app.asar`
and macOS may call the app "damaged" in some situations (for example after it is quarantined
again). To recover, run `install` without the flag (re-signs ad hoc) or reinstall Orca.

## Security

- The bridge listens on **127.0.0.1 only**, requires a **random 256-bit token**, and rejects
  cross-origin pages.
- Only **read-only navigation requests** reach language servers. There is no `executeCommand`,
  workspace edits or configuration changes.
- Files are read only inside **Orca's worktrees**. The filesystem root and your home directory
  are never used as a project root.
- Language-server binaries come from your `PATH` and standard install dirs. A repository's own
  `node_modules/.bin` is **never** used unless you opt in (`--trust-project-binaries` on the
  standalone bridge).
- Hover markdown is rendered untrusted. Document links are limited to `file:`, `http:` and
  `https:`.

## Use it in your own Monaco app

```ts
import * as monaco from 'monaco-editor'
import { createMonacoLspClient, bridgeUrl } from '@mlp/monaco-lsp-client'

const client = createMonacoLspClient(monaco, {
  url: bridgeUrl(port, token), // or an async function, called on every reconnect
  host: {
    // Open another file in your app, then reveal target.range.
    openLocation: async (target) => openInMyEditor(target.uri, target.range)
  }
})
```

Run the bridge with `node packages/lsp-bridge/dist/cli.js --root <project> --print-url`. Models
must use `file://` URIs (`monaco.Uri.file(path)`).

## Repository layout

| Path                         | What                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| `packages/protocol`          | Client ↔ bridge wire contract (JSON-RPC over WebSocket)        |
| `packages/lsp-bridge`        | Node bridge + `mlp-bridge` CLI: owns language-server processes |
| `packages/monaco-lsp-client` | Browser library: Monaco providers, peek models, navigation     |
| `packages/orca-plugin`       | Orca plugin hosting the bridge                                 |
| `packages/orca-injector`     | Script injected into Orca's renderer                           |
| `packages/orca-patcher`      | `monaco-lsp-orca` CLI: install/uninstall/status/doctor         |
| `packages/orca-patch-core`   | Patch logic shared by the CLI and the plugin's self-repair     |
| `apps/demo`                  | Standalone demo + Playwright e2e for all four languages        |
| `apps/orca-sim`              | Orca simulation for end-to-end tests of the full chain         |
| `fixtures/`                  | Tiny multi-file projects per language                          |
| `vendor/orca-lsp/`           | MIT reference code from upstream Orca PRs #14873 and #24703    |

## Development

```sh
pnpm install
pnpm build
pnpm test            # unit + integration (real language servers when installed)
pnpm typecheck
pnpm format:check
pnpm --filter demo e2e       # Playwright: demo app, all four languages
pnpm --filter orca-sim e2e   # Playwright: full Orca chain (patched renderer → plugin → servers)
pnpm --filter demo dev   # http://localhost:5173/?root=fixtures/ts&file=src/app.ts
```

## License

MIT. `vendor/orca-lsp/` contains code from Orca (MIT, © 2026 Lovecast Inc.); see its README.
