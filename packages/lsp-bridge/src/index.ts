export { createBridge } from './bridge/create-bridge'
export type { Bridge } from './bridge/create-bridge'
export type {
  AllowedRootsProvider,
  AllowedRootsQuery,
  BridgeOptions,
  HostNavigationResult,
  HostNavigationTarget,
  HostNavigator
} from './bridge/bridge-options'
export type { BridgeLogger, LogLevel } from './logger'
export { createStderrLogger, silentLogger } from './logger'
export {
  availableLanguages,
  LSP_SERVER_CATALOG,
  resolveAllServers,
  resolveLspServerForLanguage,
  toLspDocumentLanguageId
} from './lsp/server-catalog'
export type {
  LspServerDescriptor,
  ResolvedLspServer,
  ServerOverride,
  ServerOverrides
} from './lsp/server-catalog'
export {
  diagnoseServers,
  type DiagnoseOptions,
  type ServerDiagnosis,
  type ServerStatus
} from './lsp/diagnose'
export { defaultExtraBinDirs, resolveExecutable } from './lsp/executable-resolver'
export { defaultServerProbe, type ProbeResult, type ServerProbe } from './lsp/server-probe'
export { detectWorkspaceRoot } from './workspace/workspace-root'
export { BRIDGE_VERSION } from './version'
