# monaco-lsp-orca

Installs the Monaco LSP injector into an installed [Orca](https://github.com/stablyai/orca) app and
copies the companion Orca plugin (`cpoepke.monaco-lsp`) to `~/.monaco-lsp-orca/plugin/`. See
[`docs/architecture.md`](../../docs/architecture.md) for how the pieces fit together.

```
monaco-lsp-orca install   [--app <path>] [--dry-run] [--force] [--fix-integrity] [--skip-plugin]
monaco-lsp-orca uninstall [--app <path>] [--force] [--purge]
monaco-lsp-orca status    [--app <path>] [--json]
monaco-lsp-orca doctor    [--json]
```

`install` backs up `app.asar`, adds `<script src="./mlp/injector.js">` to Orca's renderer
`index.html` and repacks the archive. `uninstall` restores the backup (or strips the injection when
there is none). Orca updates replace `app.asar`, so run `status` after updating and `install` again
if needed.

## sudo

If Orca is installed where your user cannot write (e.g. a system-wide deb/rpm), run
`sudo monaco-lsp-orca install`. Under `sudo` the patcher still writes its state and the plugin
folder to **your** home (looked up from `SUDO_USER`), not root's, and hands those files back to you
(`SUDO_UID`/`SUDO_GID`).

## macOS: ad-hoc re-signing

Modifying `Orca.app/Contents/Resources/app.asar` breaks the bundle's code signature seal, so after
patching (and after `uninstall`) the patcher re-signs the app ad hoc with
`codesign --force --deep --sign -`. `--deep` replaces the signature of the app **and every nested
helper and framework**. Consequences:

- **Gatekeeper.** If macOS refuses to open Orca, right-click Orca.app → Open once, or run
  `xattr -dr com.apple.quarantine /Applications/Orca.app`.
- **Code identity changes.** An ad-hoc signature has no Team ID; its designated requirement is the
  cdhash of the patched binary. Anything bound to Orca's Developer ID signature no longer matches:
  - keychain items created by Orca (for example secrets stored through Electron `safeStorage`) may
    prompt for access again or become unreadable, so saved credentials may need to be re-entered;
  - macOS privacy (TCC) grants such as Files & Folders, Accessibility or Screen Recording may be
    requested again.
- **Auto-update.** Orca's updater may reject updates while the installed app is ad-hoc signed. If an
  update fails, reinstall Orca from the official download and run `monaco-lsp-orca install` again.
- **Reverting.** `uninstall` restores the original `app.asar`, but it **cannot restore the Developer
  ID signature**. To fully revert (signature, keychain access, TCC grants, auto-update), reinstall
  Orca from the official download.

If `Info.plist` carries `ElectronAsarIntegrity` and Orca refuses to start after patching, re-run
`install --fix-integrity` to remove the stale hash.
