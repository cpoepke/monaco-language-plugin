export type Logger = {
  debug?(message: string): void
  info?(message: string): void
  warn?(message: string): void
  error?(message: string): void
}

/** Default logger: warnings and errors go to the console, the rest is dropped. */
export const consoleWarnLogger: Logger = {
  warn: (message) => console.warn(message),
  error: (message) => console.error(message)
}
