export const PATCHER_VERSION = '0.1.0'

/** Orca plugin key (`${publisher}.${id}`) of the companion plugin. */
export const PLUGIN_KEY = 'cpoepke.monaco-lsp'

export const MARKER_BEGIN = '<!-- mlp:begin -->'
export const MARKER_END = '<!-- mlp:end -->'

/** Paths inside app.asar (posix). */
export const RENDERER_DIR = 'out/renderer'
export const RENDERER_INDEX = 'out/renderer/index.html'
export const RENDERER_ASSETS_DIR = 'out/renderer/assets'
export const INJECTOR_ASAR_PATH = 'out/renderer/mlp/injector.js'
export const VERSION_ASAR_PATH = 'out/renderer/mlp/version.json'
/** The `src` used in index.html (relative to out/renderer/index.html). */
export const INJECTOR_SCRIPT_SRC = './mlp/injector.js'

/**
 * Minified monaco-editor code that publishes `globalThis.monaco` when `MonacoEnvironment.globalAPI`
 * is set at module-evaluation time. The injector's capture trap depends on it (docs/spikes.md Q1).
 */
export const MONACO_GLOBAL_API_ANCHOR = 'MonacoEnvironment?.globalAPI&&(globalThis.monaco='

/** Sibling files next to app.asar. */
export const BACKUP_SUFFIX = '.mlp-backup'
export const BACKUP_META_SUFFIX = '.mlp-backup.json'
export const TMP_SUFFIX = '.mlp-tmp'

/** Env var overriding the patcher home (state + installed plugin). */
export const HOME_ENV = 'MONACO_LSP_ORCA_HOME'
export const HOME_DIRNAME = '.monaco-lsp-orca'
