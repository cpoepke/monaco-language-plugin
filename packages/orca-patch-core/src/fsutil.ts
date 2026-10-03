import { createHash } from 'node:crypto'
import { fs } from './fs.js'
import os from 'node:os'
import path from 'node:path'

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export function exists(p: string): boolean {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** Write via `<file>.tmp-<pid>` + rename so readers never see a partial file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

/**
 * Replace `dest` with a copy of `src` atomically: copy to `tmpPath` (same directory as `dest`, so the
 * rename cannot cross filesystems), fsync, then rename over `dest`.
 */
export function atomicReplace(src: string, dest: string, tmpPath: string): void {
  fs.rmSync(tmpPath, { force: true })
  try {
    fs.copyFileSync(src, tmpPath)
    const fd = fs.openSync(tmpPath, 'r+')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmpPath, dest)
  } catch (error) {
    fs.rmSync(tmpPath, { force: true })
    throw error
  }
}

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // best effort
  }
}

/** Recursive copy that replaces `dest` entirely. */
export function replaceDir(src: string, dest: string): void {
  const staging = `${dest}.tmp-${process.pid}`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.cpSync(src, staging, { recursive: true })
  fs.rmSync(dest, { recursive: true, force: true })
  fs.renameSync(staging, dest)
}

export function isWritable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}
