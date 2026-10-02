// Adapted from stablyai/orca PR #14873 (MIT). See vendor/orca-lsp.
import { describe, expect, it } from 'vitest'
import { encodeLspMessage, LspMessageDecoder } from './message-framing'

describe('encodeLspMessage', () => {
  it('uses the utf8 byte length, not the string length', () => {
    const encoded = encodeLspMessage({ text: 'héllo' }).toString('utf8')
    const body = encoded.slice(encoded.indexOf('\r\n\r\n') + 4)
    expect(encoded).toContain(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`)
  })
})

describe('LspMessageDecoder', () => {
  it('decodes a message split across arbitrary chunk boundaries', () => {
    const decoder = new LspMessageDecoder()
    const encoded = encodeLspMessage({ jsonrpc: '2.0', id: 1, result: { value: 'héllo 🎉' } })
    const out: unknown[] = []
    for (let i = 0; i < encoded.length; i += 3) {
      out.push(...decoder.push(encoded.subarray(i, i + 3)))
    }
    expect(out).toEqual([{ jsonrpc: '2.0', id: 1, result: { value: 'héllo 🎉' } }])
  })

  it('decodes byte-by-byte, including a split inside a multi-byte character', () => {
    const decoder = new LspMessageDecoder()
    const encoded = encodeLspMessage({ v: '€€€' })
    const out: unknown[] = []
    for (const byte of encoded) {
      out.push(...decoder.push(Buffer.from([byte])))
    }
    expect(out).toEqual([{ v: '€€€' }])
  })

  it('decodes multiple messages arriving in one chunk', () => {
    const decoder = new LspMessageDecoder()
    const chunk = Buffer.concat([
      encodeLspMessage({ id: 1 }),
      encodeLspMessage({ id: 2 }),
      encodeLspMessage({ id: 3 })
    ])
    expect(decoder.push(chunk)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it('keeps a trailing partial message for the next chunk', () => {
    const decoder = new LspMessageDecoder()
    const second = encodeLspMessage({ id: 2 })
    expect(
      decoder.push(Buffer.concat([encodeLspMessage({ id: 1 }), second.subarray(0, 10)]))
    ).toEqual([{ id: 1 }])
    expect(decoder.push(second.subarray(10))).toEqual([{ id: 2 }])
  })

  it('tolerates extra headers like Content-Type', () => {
    const decoder = new LspMessageDecoder()
    const body = JSON.stringify({ id: 7 })
    const raw = Buffer.from(
      `Content-Length: ${body.length}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n${body}`,
      'utf8'
    )
    expect(decoder.push(raw)).toEqual([{ id: 7 }])
  })

  it('skips a malformed body and keeps decoding subsequent messages', () => {
    const decoder = new LspMessageDecoder()
    const bad = Buffer.from('Content-Length: 3\r\n\r\n{{{', 'utf8')
    expect(decoder.push(Buffer.concat([bad, encodeLspMessage({ id: 2 })]))).toEqual([{ id: 2 }])
  })
})
