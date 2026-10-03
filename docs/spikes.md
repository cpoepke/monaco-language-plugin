# Phase-0 spikes: Orca integration facts

Target: Orca `main` (fetched 2026-10-02), monaco-editor 0.55.1, @monaco-editor/react 4.7.0,
Orca's bundler `vite: npm:rolldown-vite@7.3.1` + `electron-vite ^5.0.0` (Orca `package.json`).

Labels: **VERIFIED** means I checked it by experiment or read the exact code path (quoted). **INFERRED** means I reasoned it from code without running it inside Orca.

Spike app and test scripts: `<scratchpad>/spike/` (`src/`, `public/mlp/injector.js`, `test*.mjs`,
`variant/`). Extracted Orca sources: `<scratchpad>/orca-main/`.

---

## Q1: Getting the Monaco API from a pre-loaded script

### a) Where `globalThis.monaco` gets assigned (monaco-editor 0.55.1 ESM), VERIFIED

Monaco assigns it in two places. Both checks run **once, while the module is being evaluated**:

`esm/vs/editor/editor.api2.js`

```js
const monacoEnvironment = getMonacoEnvironment() // = globalThis.MonacoEnvironment
const globalWithAMD = globalThis
if (
  monacoEnvironment?.globalAPI ||
  (typeof globalWithAMD.define === 'function' && globalWithAMD.define.amd)
) {
  globalWithAMD.monaco = api
}
```

`esm/vs/editor/internal/initialize.js` (imported by `editor.main.js`)

```js
const monacoEnvironment = globalThis.MonacoEnvironment
if (monacoEnvironment?.globalAPI) {
  globalThis.monaco = getGlobalMonaco() // editor.api2 namespace
}
```

After that, `editor.main.js` adds `monacoApi.languages.typescript/json/css/html = ...`. These namespaces
exist at runtime, but they are not in the `.d.ts`. The `.d.ts` only declares the top-level exports
`typescript`, `json`, `css`, `html` and `lsp`.
Other `MonacoEnvironment` readers (`getWorker`/`getWorkerUrl` in `common/workers.js`,
`base/browser/webWorkerFactory.js`, `trustedTypes.js`) read it **lazily**, when a worker is created.

Orca's `src/renderer/src/lib/monaco-setup.ts` imports `monaco-editor`, then runs
`globalThis.MonacoEnvironment = { getWorker(...) {...} }` and later `loader.config({ monaco })`.
ESM evaluates imports first, so Monaco's `globalAPI` check runs **before** Orca's assignment. It sees
whatever our pre-loaded script put there.

The minified rolldown output keeps both checks:

```
globalThis.MonacoEnvironment?.globalAPI&&(globalThis.monaco=Hi());           // MonacoEditor-*.js
(gze?.globalAPI||typeof $9.define==`function`&&$9.define.amd)&&($9.monaco=R9) // editor.api2-*.js
```

### b) Experiment: a classic `<script>` trap in a production build, VERIFIED

Setup in `spike/`:

- rolldown-vite 7.3.1 with Orca's renderer build options: `worker.format:'es'`, `minify:'oxc'`,
  `target:'es2020'`, `modulePreload.polyfill`, `manifest`, `base:'./'`.
- React 19 with `lazy(() => import('./MonacoEditor'))`, mirroring Orca's `editor-lazy-views.ts`.
- `src/monaco-setup.js` copies Orca's imports and `?worker` workers, the `globalThis.MonacoEnvironment`
  assignment, `typescript.*Defaults.setDiagnosticsOptions` and `loader.config({ monaco })`.
- `index.html` has `<script src="./mlp/injector.js"></script>` before the module script. Vite leaves it
  untouched, and it appears in `dist/index.html` ahead of `<script type="module" crossorigin src="./assets/index-*.js">`.

I loaded the result in Playwright Chromium over both `vite preview` (http) and `file://`:

```
hasGlobalMonaco: true, registerDefinitionProvider: "function",
sameEditorNsAsBundle: true, sameAsOnMount: true,          // same objects Orca's code gets
envHasGetWorker: "function", envGlobalAPI: true,          // Orca's getWorker survived the trap
workerLabels: ["typescript","editorWorkerService"],       // workers created through Orca-style getWorker
editors: 1, tokenized: true, no console errors (file://)
```

Further checks (`test2.mjs` and `test3.mjs`):

- A real Ctrl+hover shows the `.goto-definition-link` underline. Ctrl+click and F12 then call the
  injected `registerDefinitionProvider`.
- A cross-file result reaches `monaco.editor.registerEditorOpener` as
  `{from:'file:///repo/src/a.ts', resource:'file:///repo/src/b.ts', sel:{1,14,1,14}}`, with no peek.
- **Model reuse:** a model the injector creates for `file:///repo/src/a.ts` _before_ the editor mounts
  is **reused** by `@monaco-editor/react` (`reusedPreModel: true`), and there is no "model already exists" error.
- **Worst-case variant** (`spike/variant/`): `MonacoEnvironment` is assigned in a module that evaluates
  _before_ monaco-editor. The accessor trap still captures `globalThis.monaco`. A plain
  `globalThis.MonacoEnvironment = {globalAPI:true}` would be overwritten in that case (INFERRED).
- At capture time `languages.typescript` does **not** exist yet (`hasTsAtCapture:false`). It exists
  one task later and is always there by the first `onLanguage` event.
- The `monaco.lsp` client (`MonacoLspClient`, `WebSocketTransport`) that 0.55 bundles **is in Orca's
  bundle** but **cannot be reached** from the global API. The global keys are only
  `CancellationTokenSource, Emitter, KeyCode, KeyMod, MarkerSeverity, MarkerTag, Position, Range,
Selection, SelectionDirection, Token, Uri, editor, languages`. We must write our own providers.
- A WebSocket from the `file://` page to `ws://127.0.0.1:<port>` works. The server sees
  `Origin: file://` (`test5.mjs`).

Recommended injector core (working copy: `spike/public/mlp/injector.js`):

```js
;(function () {
  var env = { globalAPI: true }
  Object.defineProperty(globalThis, 'MonacoEnvironment', {
    configurable: true,
    enumerable: true,
    get: function () {
      return env
    },
    set: function (v) {
      env = Object.assign({}, v, { globalAPI: true })
    }
  }) // keeps Orca's getWorker
  var current,
    captured = null,
    waiters = []
  Object.defineProperty(globalThis, 'monaco', {
    configurable: true,
    enumerable: true,
    get: function () {
      return current
    },
    set: function (v) {
      // Monaco assigns twice; first wins
      current = v
      if (captured || !v || !v.editor || !v.languages) return
      captured = v
      ;['typescript', 'javascript'].forEach(function (lang) {
        // see Q4: turn off built-in TS nav
        v.languages.onLanguage(lang, function () {
          var ts = v.languages.typescript
          var d = ts && (lang === 'typescript' ? ts.typescriptDefaults : ts.javascriptDefaults)
          if (d)
            d.setModeConfiguration(
              Object.assign({}, d.modeConfiguration, {
                definitions: false,
                references: false,
                hovers: false
              })
            )
        })
      })
      setTimeout(function () {
        waiters.splice(0).forEach(function (f) {
          f(v)
        })
      }, 0) // after editor.main.js
    }
  })
  window.__mlpWhenMonaco = function (f) {
    captured ? f(captured) : waiters.push(f)
  }
})()
```

**Fallback if the trap ever breaks:** the post-install patcher can check that the anchor
`MonacoEnvironment?.globalAPI&&(globalThis.monaco=` is present in `out/renderer/assets/*.js`
(property names are not mangled). If the anchor is missing, it should fail loudly rather than
string-patch blind. Do not rely on `window.require` or `define`: Orca has no AMD loader, and defining
`define.amd` would change how other libraries behave.

### c) Orca's renderer build config, VERIFIED

`electron.vite.config.ts` `renderer`: `plugins: [react(), tailwindcss(), createPdfjsViewerAssetsPlugin()]`,
`worker: { format: 'es' }`, `build: { manifest: true, modulePreload: { polyfill: true }, minify: 'oxc',
target: 'es2020', rollupOptions: { preserveEntrySignatures: 'strict', input: { index, popout, web } } }`.
It has no `manualChunks`, no monaco plugin, no renderer `define`, and no `globalThis.monaco` or AMD.
The `define` with `ORCA_BUILD_IDENTITY` and similar applies to **main** only. Nothing here changes
the result above. Note the extra entries `popout.html` and `web-index.html`. The editor lives in
`index.html`, and injecting into `popout.html` is optional.

**Decision:** inject a classic `<script>` that installs `MonacoEnvironment` and `monaco` accessor traps. This captured the API with Orca's import pattern, minified and over `file://`. The patcher should also sanity-check the `globalAPI` anchor.

---

## Q2: Orca runtime RPC to open a file

**Method:** `files.open`, VERIFIED. It is defined in `src/main/runtime/rpc/methods/files.ts`:

```ts
defineMethod({
  name: 'files.open',
  params: FileOpenTab,
  handler: async (params, { runtime }) =>
    runtime.openMobileFile(params.worktree, params.relativePath, params.navigation)
})
```

**Params** (`src/shared/rpc-contract/files-target-params.ts` and `files-params.ts`):
`{ worktree: string (min 1), relativePath: string (min 1), navigation?: 'caller'|'host'|'clients'|'all' }`.

- `relativePath` must pass `isSafeMobileRelativePath`. That means not absolute, no drive letter, and no
  empty, `.` or `..` segment (`runtime-file-command-host.ts:156`). So you **cannot open files outside a
  worktree**, such as TS libs or `~/.cargo`.
- Missing files fail with `ENOENT: ...`, because the handler stats first.
- Binaries return `{opened:false}`.
- Result: `{ worktree: <id>, relativePath, kind: 'text'|'markdown'|'image'|'binary', opened: boolean }`.
- `navigation` (`runtime-navigation.ts`, renderer `openRuntimeEditorTab`):
  - `'host'` or `'all'`: the main window runs `setActiveWorktree`, `setActiveView('terminal')`,
    `openFile(..., {selection:'focus'})` and `revealWorktreeInSidebar`.
  - `'caller'` or `'clients'`: opens in the background and changes nothing on screen.
  - The CLI sends `'caller'`, or `'all'` with `--focus`. **Use `'host'`.**

**Worktree selector**, VERIFIED (`orca-runtime-resolve-worktree-selector.ts`):

- `id:<worktreeId>`
- `path:<abs worktree root>` (`runtimePathsEqual`)
- `branch:<b>`, `name:<displayName>`, `issue:<n>`, `identity:<key>`
- a bare string matches `id`, `path` or `branch`
- `'active'` throws `selector_not_found`; the CLI resolves "active" on the client side

Other errors are `selector_ambiguous` and `selector_not_found`. A worktree id has the form
`<repoId><SEP><worktreePath>` (`shared/worktree/id.ts`). **Use `path:<root>`.**

**How the renderer gets told**, VERIFIED:

1. `notifier.openFile` sends IPC `'ui:openFileFromMobile'`
   `{worktreeId, filePath, relativePath, runtimeEnvironmentId, navigation}` (`main/window/runtime-window-lifecycle.ts:172`).
2. The preload exposes it as `window.api.ui.onOpenFileFromMobile`.
3. The renderer calls `store.openFile({filePath, relativePath, worktreeId, language, mode:'edit'}, {selection})`
   (`hooks/ipc-events/mobile-terminal-close-ipc-bridge.ts`).

**No line, column or selection can be passed.** No RPC carries a position: there is no
`editor.reveal`, `files.openAt` or similar in `rpc-params-catalog.generated.ts`. `setPendingEditorReveal`
is used only by renderer-local code (search results, terminal links, markdown links, annotations).
⇒ **The injector applies the reveal itself** (see Q4).

**List worktrees**, VERIFIED: `worktree.list` with params `{repo?: string, limit?: number}` (default
limit 200). It returns `{ worktrees: RuntimeWorktreeRecord[] /* Worktree & {id, repoId, path, branch,
displayName, git, ...} */, totalCount, truncated }`. `repo.list` also exists (`params: null`). Map an
absolute file to the **longest** worktree `path` that is a prefix of it. Then send `path:<that root>`
with `relativePath = path.relative(root, file)` using forward slashes.

**Metadata file**, VERIFIED (`shared/runtime-bootstrap.ts`, `cli/runtime/metadata.ts`):
`<userData>/orca-runtime.json` (mode 0o600), where `<userData>` is:

- macOS: `~/Library/Application Support/orca`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/orca`
- Windows: `%APPDATA%\orca`
- `ORCA_USER_DATA_PATH` overrides it. Dev builds use `<appData>/orca-dev`.

Shape:

```ts
{ runtimeId: string, pid: number, authToken: string|null, startedAt: number,
  transports: Array<{kind:'unix'|'named-pipe'|'websocket', endpoint: string}> }  // legacy: `transport`
```

Endpoints are `<userData>/o-<pid>-<suffix>.sock` (Unix) or `\\.\pipe\orca-<pid>-<suffix>` (Windows).
To pick one: `findTransport(meta, 'unix', 'named-pipe')`.

**Framing and auth**, VERIFIED:

- The client (`cli/runtime/transport.ts`) does `net.createConnection(endpoint)` and writes
  `JSON.stringify({id, authToken, method, params})+'\n'`. It reads newline-delimited frames, skips
  keepalive frames, and matches on `id`.
- The server (`rpc/unix-socket-transport.ts`) dispatches every `\n`-terminated line, so several
  requests per socket are possible. It applies an idle timeout and a max frame size.
- `runtime-rpc-request-admission.ts` `parseAndAuth` rejects these cases:
  - missing `id`: `bad_request`
  - missing `method`: `bad_request`
  - missing or wrong `authToken`: `unauthorized` ("Missing auth token" or "Invalid auth token")
- Response: `{id, ok:true, result, _meta}` | `{id, ok:false, error:{code,message,data?}, _meta}`.

Ready-to-use request (one connection per request, the same pattern as the CLI):

```
{"id":"mlp-1","authToken":"<meta.authToken>","method":"files.open","params":{"worktree":"path:/abs/path/to","relativePath":"file.ts","navigation":"host"}}\n
```

To find the root first:
`{"id":"mlp-0","authToken":"…","method":"worktree.list","params":{"limit":1000}}\n`

**Decision:** the bridge reads `orca-runtime.json`, maps paths through `worktree.list`, and sends `files.open` with `path:<root>` and `navigation:'host'`. Out-of-worktree targets need a peek-only or read-only fallback. The position is applied in the renderer.

---

## Q3: Waking the plugin worker from the renderer; the worker API

**Renderer surface**, VERIFIED: `src/preload/index.ts` runs `contextBridge.exposeInMainWorld('api', api)`
with `plugins: pluginsApi`. In `src/preload/api/plugins-bridge.ts`:

```ts
invokeCommand: (args: { pluginKey: string; commandId: string; args?: unknown }) =>
  ipcRenderer.invoke('plugins:invokeCommand', args),
```

Main side (`main/ipc/plugins.ts:176` and `plugin-service.ts:271`):

```ts
const plugin = this.findValidPlugin(pluginKey)
if (!plugin || !this.canStartPluginWork(plugin))
  throw new Error(`plugin ${pluginKey} is not enabled`)
assertPluginWorkerCommand(plugin, commandId) // must be in manifest contributes.commands, no `action`
const handle = await this.workerController.ensure(plugin) // <- starts the worker if not running
return handle.invokeCommand(commandId, args) // returns the handler's value (structured clone)
```

The exact injector call:

```js
const r = await window.api.plugins.invokeCommand({
  pluginKey: '<publisher>.<id>',
  commandId: 'mlp.ensureBridge',
  args: { v: 1 }
})
// e.g. r = { port, token }
```

Requirements:

- `settings.pluginSystemEnabled === true` (opt-in, `main-process-plugins.ts:62`).
- The plugin is installed, enabled and consented.
- The manifest has `contributes.commands: [{ id: 'mlp.ensureBridge', title: '…' }]` and `main`.
- The worker calls `orca.commands.register('mlp.ensureBridge', …)` inside `activate`.

The pluginKey is `${publisher}.${id}` (`qualifiedPluginKey`).

**Lifecycle**, VERIFIED:

- Workers start lazily (`plugin-worker-manager.ts` "Owns lazy activation … idle reap").
- They are **reaped after 5 min idle** (`PLUGIN_WORKER_IDLE_REAP_MS = 5*60_000`, checked every 60 s,
  and skipped while `inFlightCount() > 0`).
- `lastActivityAt` refreshes on command results, event acks and `hostCall`. To stay alive while
  sessions exist, either:
  - the injector re-invokes a `ping` command at least every 4 min (it also gets a new port if the
    worker restarted), or
  - the worker calls `orca.host.call('storage.get', …)` periodically, which needs a `{kind:'storage'}`
    capability.
- Invoke timeout is 30 s and ready timeout is 10 s.

**`activate(orca)` receives**, VERIFIED (`main/plugins/plugin-host-runtime.ts`):

```ts
type PluginWorkerOrcaApi = {
  commands: { register(commandId: string, handler: (args: unknown) => unknown): void }
  events: { on(event: 'worktree.created' | 'worktree.removed' | 'agent.status.changed', h): void }
  host: { call(method: string, params?: unknown): Promise<unknown> } // capability-gated
  grantedCapabilities: readonly string[]
  log(message: string): void
}
```

The entry must `export default` the activate function; it may also export `deactivate`. Host methods:
`workspace.readContext`, `terminal.sendText`, `notifications.show`, `storage.*`, `secrets.*`,
`settings.get/set`, `events.subscribe`. None of them opens files.

**Worker environment and userData**, VERIFIED:

- `fork(entryPath, [], { env: buildPluginWorkerEnv(), execArgv: [], serialization:'advanced' })`.
  No `cwd` is set, so the worker inherits the main-process cwd. No `execPath` is set either, so
  the worker runs Orca's own executable (`process.execPath` = `Orca.app/Contents/MacOS/<bin>`,
  `Orca.exe`, `orca-ide`) and `process.ppid` is Orca's main process. The self-repair derives
  `app.asar` from it (`plugin-host-process.ts` `startPluginWorker`).
- Manifest-declared events start a stopped worker: `deliverPluginEvent`
  (`plugin-event-delivery.ts`) calls `workerController.ensure(plugin)` before delivering, which
  is how the plugin gets started after an update removed the injector.
- The env allowlist is `PATH, HOME, USERPROFILE, LANG, LC_*, TZ, TMP*, SYSTEMROOT…` plus
  `ELECTRON_RUN_AS_NODE=1`. **`APPDATA`, `XDG_CONFIG_HOME` and `ORCA_USER_DATA_PATH` are stripped.** argv
  is empty.
- The installed plugin root is `<userData>/plugins/<pluginKey>/<contentHash>/`
  (`getUserPluginsDir` = `join(userData,'plugins')`, and `readInstalledPlugin` uses the `current` pointer).
  ⇒ `userData = path.resolve(pluginRoot, '../../..')`, where `pluginRoot` comes from
  `import.meta.url` or `__dirname` of the entry.
- Verify by checking that `<userData>/orca-runtime.json` exists. Fall back to OS defaults built from
  `HOME` or `USERPROFILE` (Windows: `USERPROFILE\AppData\Roaming\orca`).
- Dev plugins (`isDev`) live elsewhere, so use the fallback for them.

**Decision:** the injector wakes the bridge with `window.api.plugins.invokeCommand({pluginKey, commandId:'mlp.ensureBridge'})`, which returns `{port, token}`, and pings every few minutes to avoid the 5-min reap. The worker derives userData from its install path (`../../..`).

---

## Q4: Editor model and URI facts in the renderer

**URI schemes**, VERIFIED:

- (i) **File tabs** use `file://` from `toEditorModelUri(filePath)`, which is
  `URI.file(fsPath).toString()` (`components/editor/editor-model-uri.ts`). `MonacoEditor.tsx` passes
  `path={modelUri}`, `keepCurrentModel` and `saveViewState={false}`. Markdown files are file tabs too
  (language `markdown`).
- (ii) **Diffs:**
  - `DiffViewer` uses `diff:original:<enc owner>:<enc key><gen>` and `diff:modified:…`
    (`diff-monaco-model-disposal.ts`), scheme `diff`.
  - The combined diff uses `diff-section:<worktree>:<sectionKey>:<gen>:original|modified`
    (`DiffSectionItem.tsx:68`), scheme `diff-section`.
  - Both are `keepCurrent*Model`.
- (iii) **Other surfaces:**
  - Notebook cells: `monaco.editor.createModel(source, cell.language)` with no URI, so `inmemory://model/N`
    (`IpynbCellEditor.tsx:176`).
  - Automation prompt editor: `<Editor>` without `path`, so `inmemory`.
  - `MonacoCodeExcerpt` only calls `monaco.editor.colorize` and creates no model.

  ⇒ Providers should act only on `file:` models (and possibly `diff…:modified`).

**Model creation and reuse**, VERIFIED:

- Orca never calls `createModel` for `file:` itself. `@monaco-editor/react` does
  `getModel(Uri.parse(path)) || createModel(value, language, uri)` (dist: `function h(e,r,n,t){return De(e,t)||be(e,r,n,t)}`).
- A model we pre-create is **reused** without error (spike result above).
- On mount Orca runs `syncContentOnMount(editor, contentRef.current, …)` (`use-monaco-editor-mount.ts`),
  which overwrites a retained model's text with the tab content (INFERRED from code).
- When a tab closes, `disposeClosedEditorModels` **disposes the unattached `file:` model** for that path
  (`closed-editor-tab-disposal.ts`).

  ⇒ Models we create for peek or preview can be disposed under us, so listen to `onWillDisposeModel`
  and re-create lazily. Do not hold stale references.

**Reveal behaviour**, VERIFIED:

- `MonacoEditor` is keyed by `${viewStateScopeId}\0${filePath}` (`EditorEditFileSurface.tsx:171`),
  so each file gets a **new editor instance** and `monaco.editor.onDidCreateEditor` fires.
- In `onMount`:
  - If `pendingEditorReveal` matches the file, Orca runs `queueReveal`: two `requestAnimationFrame`s,
    then it waits (≤120 frames) until `model.getLineCount() >= line`, because "fresh opens can mount an
    empty 1-line model before the async read". It then calls `performReveal`, which does
    `setPosition`, `setSelection`, `revealPositionInCenter` (or `revealRangeInCenter`) and `focus()`.
  - Otherwise `restoreMonacoViewState`, after **one rAF**, calls `setSelections(saved)`,
    `setScrollTop(saved)` and `focus()`.
- So Orca **does move the cursor after mount** and would overwrite an immediate reveal.

⇒ In the injector, after the `files.open` reply:

1. Find an existing visible editor whose model URI matches, or wait for `onDidCreateEditor` plus
   `onDidChangeModel` with that URI.
2. Wait at least 2 rAFs **and** until the line count ≥ target (poll, with a cap). Then set the
   selection and `revealRangeInCenter`.
3. If the file is already the active editor, reveal directly.

**Orca's own navigation hooks**, VERIFIED (grep over `src/renderer`): Orca has no
`registerDefinitionProvider`, `registerHoverProvider`, `registerReferenceProvider`,
`registerLinkProvider` or `registerEditorOpener`, and no Ctrl/Cmd+click handling.

- Its only `onMouseDown` is the gutter right-click menu.
- `addAction('orca.searchInFiles')`: "until Orca has semantic LSP references … search the visible
  symbol text" (`monaco-codebase-search.ts`).
- Its only provider is a markdown completion provider.
- `monaco-peek-preview-options.ts` patches `ReferenceWidget.prototype._fillBody/_revealReference` only
  to apply preview editor options. That is compatible with our peek.

So Cmd+click works as soon as we register providers. Cross-file targets **need**
`monaco.editor.registerEditorOpener` (standalone default: "do nothing for models other than the
currently attached one"). This was verified in the spike.

**TS worker config**, VERIFIED (`monaco-setup.ts`):

- Diagnostics are fully off: `noSemanticValidation`, `noSuggestionDiagnostics` and
  `noSyntaxValidation` are all true.
- `jsx: Preserve` is set on TS and JS.
- `modeConfiguration` is left at its **defaults**, so built-in TS/JS `definitions`, `references`,
  `hovers`, completion and so on are active. These produce duplicate or bogus single-file results
  next to ours.
- Orca uses the top-level ESM export (`import { typescript as monacoTS } from 'monaco-editor'`). The
  injector only has `monaco.languages.typescript`, which exists at runtime in 0.55 but is untyped.
- `tsMode.setupMode` reads `modeConfiguration` **once**, asynchronously after the first TS/JS model.
  So `setModeConfiguration({...defaults, definitions:false, references:false, hovers:false})` must run
  in a synchronous `languages.onLanguage(lang, …)` listener or earlier. That is verified to run in the
  spike. The effect on duplicate results is INFERRED from `tsMode.js`
  (`if (modeConfiguration.definitions) providers.push(...)`).

**Decision:** register providers for `file:` models only and add a `registerEditorOpener` that routes to the bridge (`files.open`). Turn off TS built-in nav through `onLanguage` plus `setModeConfiguration`. Apply our own reveal after 2 rAFs and content load. Tolerate Orca disposing `file:` models.

---

## Q5: Packaged layout

- **Renderer entry**, VERIFIED: electron-vite 5 defaults (`electronRendererConfigPresetPlugin`) are
  `root: './src/renderer'`, `outDir: out/renderer`, and `base = './'` in production. Orca overrides
  neither. ⇒ `out/renderer/index.html` (also `popout.html` and `web-index.html`) with
  `<script type="module" crossorigin src="./assets/index-<hash>.js">` plus modulepreload links. The
  spike's `dist/index.html` has the same shape.
- **Main window**, VERIFIED (`src/main/window/createMainWindow.ts:39-41`):
  `is.dev && ELECTRON_RENDERER_URL ? loadURL(...) : mainWindow.loadFile(join(__dirname, '../renderer/index.html'))`,
  with `webPreferences: { preload, sandbox: true, webviewTag: true }`. So packaged builds load
  `file://…/app.asar/out/renderer/index.html`, and a relative `<script src="./mlp/injector.js">`
  resolves to `app.asar/out/renderer/mlp/injector.js` (INFERRED; the spike verified relative classic
  scripts over `file://`).
- **Packaging**, VERIFIED (`config/electron-builder.config.cjs`): `files` does not exclude
  `out/renderer` (it excludes only `out/renderer/.vite`, maps and tests). `out/renderer` is **not** in
  `asarUnpack` (that only has `out/main/plugin-host-entry.js` and similar). ⇒ the renderer lives
  **inside `app.asar`**, so the patcher must extract and repack the asar.
- There are no `electronFuses` and no asar-integrity config in the builder config (INFERRED: default
  fuses, so asar integrity is not enforced).
- Linux ships as **AppImage** (`afterPack` writes `package-type: AppImage`), which is read-only.
  macOS modifications break the bundle signature seal (INFERRED risks for the patcher).
- **CSP**, VERIFIED: `src/renderer/index.html` has **no CSP meta**. The comment "electron-vite
  injects a stricter policy for production builds" is not borne out: electron-vite 5's dist contains
  no CSP code, and Orca's main sets no CSP header for the main window. The only `webRequest` hook on
  the default session is the proxy readiness guard. Inline or relative scripts and `ws://127.0.0.1`
  are not blocked (INFERRED for the packaged app; WS from `file://` verified in Chromium).

**Decision:** the patcher adds `<script src="./mlp/injector.js"></script>` as the first child of `<head>` in `app.asar/out/renderer/index.html` (optionally `popout.html`), copies `injector.js` to `out/renderer/mlp/`, and repacks `app.asar`. No CSP changes are needed. Plan separately for AppImage, macOS signing and updates.
