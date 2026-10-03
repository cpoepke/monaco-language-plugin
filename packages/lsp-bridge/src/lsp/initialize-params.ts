// Adapted from stablyai/orca PR #14873 (MIT). See vendor/orca-lsp.
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

export type WorkspaceFolder = { uri: string; name: string }

export function workspaceFoldersFor(rootPath: string): WorkspaceFolder[] {
  return [{ uri: pathToFileURL(rootPath).toString(), name: basename(rootPath) || rootPath }]
}

/** Client capabilities for the bridge: read-only navigation (definition family,
 *  references, hover, symbols, links) plus push + pull diagnostics over
 *  full-text sync. Advertising `diagnostic` lets pull-model servers (tsgo/TS7)
 *  expose their diagnosticProvider. Nothing that edits files (completion edits,
 *  code actions, rename) is advertised: the bridge never forwards those. */
export function buildLspInitializeParams(rootPath: string): object {
  const workspaceFolders = workspaceFoldersFor(rootPath)
  const linkCapable = { dynamicRegistration: false, linkSupport: true }
  return {
    // Why: servers watch this pid and exit when the bridge dies, so a hard-killed
    // bridge does not leave orphaned language servers behind.
    processId: process.pid,
    clientInfo: { name: 'mlp-lsp-bridge' },
    rootUri: workspaceFolders[0]?.uri ?? null,
    rootPath,
    workspaceFolders,
    capabilities: {
      general: { positionEncodings: ['utf-16'] },
      textDocument: {
        synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
        definition: linkCapable,
        declaration: linkCapable,
        typeDefinition: linkCapable,
        implementation: linkCapable,
        references: { dynamicRegistration: false },
        hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
        documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
        documentLink: { dynamicRegistration: false, tooltipSupport: true },
        publishDiagnostics: { relatedInformation: true, versionSupport: true },
        diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false }
      },
      workspace: {
        workspaceFolders: true,
        configuration: true,
        // Why: gopls and rust-analyzer don't watch the disk themselves; they
        // register watchers and expect the client to report file changes.
        didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: true }
      },
      window: { workDoneProgress: false }
    }
  }
}
