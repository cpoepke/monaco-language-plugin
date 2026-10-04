# monaco-lsp-orca

Installs the Monaco LSP injector into an installed [Orca](https://github.com/stablyai/orca) app and
copies the companion Orca plugin (`cpoepke.monaco-lsp`) to `~/.monaco-lsp-orca/plugin/`. See
[`docs/architecture.md`](../../docs/architecture.md) for how the pieces fit together.

```
monaco-lsp-orca install   [--app <path>] [--dry-run] [--force] [--fix-integrity] [--skip-plugin]
                          [--no-resign] [--no-auto-repair]
monaco-lsp-orca uninstall [--app <path>] [--force] [--purge]
monaco-lsp-orca status    [--app <path>] [--json]
monaco-lsp-orca doctor    [--json]
```

`install` backs up `app.asar`, adds `<script src="./mlp/injector.js">` to Orca's renderer
`index.html` and repacks the archive. `uninstall` restores the backup (or strips the injection when
there is none).

## doctor: do the language servers actually work?

`monaco-lsp-orca doctor` asks the bridge's own resolver (the same server catalog, search
directories and version-command probe the plugin uses) about every supported server, so it reports
what Orca would do rather than just whether a file exists:

```
  ok       Go                     gopls → /home/me/go/bin/gopls  (golang.org/x/tools/gopls v0.23.0)
  broken   Rust                   rust-analyzer → /home/me/.cargo/bin/rust-analyzer
                                  exited with 1: error: Unknown binary 'rust-analyzer' in official toolchain 'stable'.
                                  fix: rustup component add rust-analyzer
  missing  Python                 install: npm install -g pyright   (or: pipx install basedpyright)
  warning  TypeScript/JavaScript  /home/me/.local/bin/typescript-language-server is not on PATH; add /home/me/.local/bin to PATH
```

- `ok`: a binary was found on PATH, `~/go/bin` or `~/.cargo/bin` and its version command
  (`--version` / `version`) exits 0. The first output line is shown.
- `broken`: a binary exists but the version command fails (for example rustup's `rust-analyzer`
  proxy without the component). The first stderr/stdout line is shown with a targeted fix:
  `rustup component add rust-analyzer`, reinstalling `typescript-language-server`, `pyright`,
  `gopls`, or a generic "reinstall" hint. The bridge treats such a binary as not installed.
- `missing`: nothing found; the install command for your OS is shown.
- `warning` (`"status": "off-path"` in JSON): found only in a common install dir outside PATH.

Within a language the first working candidate wins (e.g. `typescript-language-server`, then `tsgo`);
a broken first candidate with a working fallback is reported as `ok` with a note.

`--json` prints the same data: `{ entries: [{ language, status, found, version?, reason?, hint,
candidates: [{ serverId, binary, status, path?, version?, reason? }] }], node, exitCode }`.

Exit code: `0` when every language has a working server, `2` when any language is missing, off PATH
or broken (unchanged: any language without a usable server). The version command is run with the
bridge's 5 s timeout, so doctor cannot hang; a timeout counts as working (a slow machine is not a
broken install) and verdicts are cached for the process lifetime.

## After Orca updates: self-repair

Orca updates replace `app.asar` and remove the patch; the plugin folder in Orca's userData
survives. The plugin re-applies the patch from its worker with the same code as this CLI
(`packages/orca-patch-core`) and the injector shipped in the plugin folder (`assets/injector.js`),
then asks you to restart Orca once. On Windows, where the running Orca keeps `app.asar` locked, the
patched archive waits as `app.asar.mlp-pending` and a detached helper swaps it in after Orca quits
(log: `~/.monaco-lsp-orca/logs/apply-pending.log`). Installs the plugin cannot write to get a
notification with the exact command (`sudo monaco-lsp-orca install --app "…"`). The backup is
refreshed to the new pristine version first, so `uninstall` restores the updated Orca, not the old
one. See [`packages/orca-plugin/README.md`](../orca-plugin/README.md#self-repair-after-orca-updates).

`~/.monaco-lsp-orca/config.json` holds the settings both sides use; `install` writes it from its
flags (a plain `install` resets both to `true`), `uninstall` sets `autoRepair` to `false` so the
plugin does not patch Orca again. Without this file auto-repair is off, so the plugin never patches
an Orca you didn't patch with the CLI:

```json
{ "autoRepair": true, "resign": true }
```

- `--no-auto-repair` → `"autoRepair": false`: the plugin only repairs when you run **Language
  Servers: Repair Orca Patch**.
- `--no-resign` → `"resign": false` (macOS, below); self-repair skips re-signing too.

The CLI and the plugin never patch at the same time: both take an exclusive lock next to the
archive (`app.asar.mlp-lock`, created with `O_EXCL`, taken over when older than 2 minutes). The CLI
waits up to 30 s for it.

## sudo

If Orca is installed where your user cannot write (e.g. a system-wide deb/rpm), run
`sudo monaco-lsp-orca install`. Under `sudo` the patcher still writes its state, `config.json` and
the plugin folder to **your** home (looked up from `SUDO_USER`), not root's, and hands those files
back to you (`SUDO_UID`/`SUDO_GID`). The plugin cannot repair such an install after an update; it
tells you to run the same command again.

## macOS: ad-hoc re-signing (default) or `--no-resign`

Modifying `Orca.app/Contents/Resources/app.asar` breaks the bundle's code signature seal, so by
default, after patching (and after `uninstall`), the patcher re-signs the app ad hoc with
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

### `--no-resign`

`install --no-resign` patches without re-signing and saves `"resign": false`, so the self-repair
after updates does not re-sign either:

- Orca keeps its **original Developer ID signature**: the code identity does not change, so
  keychain items and privacy (TCC) grants should keep working, and Orca's auto-update will likely
  keep working.
- But the signature's **resource seal is broken** (`codesign --verify` reports the modified
  `app.asar`). macOS may refuse to launch the app ("Orca is damaged") in some situations, for
  example if it gets quarantined again.
- **Recover** with `monaco-lsp-orca install` (re-signs ad hoc) or by reinstalling Orca.
- `uninstall` in this mode restores the original `app.asar`; if the Developer ID signature then
  verifies again, nothing is re-signed.

`status` shows the signing mode and, on macOS, the result of `codesign --verify --deep --strict`.

## Testing on macOS

Neither mode has been tested on a real Mac yet; the default stays re-signing until one has. If you
can, please try `--no-resign` first and report:

1. `monaco-lsp-orca install --no-resign`, then start Orca: does it launch (also after a reboot),
   and does Code Navigation work? What does `monaco-lsp-orca status` print for `codesign`?
2. When the next Orca update arrives: does the auto-update install, and does the plugin re-enable
   code navigation afterwards (one more restart)?
3. Any keychain or privacy prompts?
