# Vendored reference code from Orca (stablyai/orca)

These files are copied **unchanged** from two open (unmerged) upstream pull requests
in [stablyai/orca](https://github.com/stablyai/orca). They are kept here as reference
material; the packages in `packages/` adapt them to run outside Orca (no Orca
imports, Monaco passed in as a parameter, WebSocket transport instead of Electron IPC).

| Directory | Source | Head commit |
|---|---|---|
| `pr14873/` | [#14873 "feat(editor): LSP support in the editor and diff views (tsgo-first)"](https://github.com/stablyai/orca/pull/14873) by @moishinetzer | `8e689bd6951f` |
| `pr24703/` | [#24703 "feat(lsp): per-project language-server navigation for TypeScript and Ruby"](https://github.com/stablyai/orca/pull/24703) by @MTEKode | `ea56e8d5dddb` |

Orca is MIT licensed; see [`LICENSE`](./LICENSE) (Copyright (c) 2026 Lovecast Inc.).
The original paths inside the Orca repository are preserved below each directory.

This directory is excluded from builds, type-checking, tests and formatting.
