import { describe, expect, it } from 'vitest'
import { parseFileLink, parseLinkFragment } from '../src/link-fragment'

const at = (line: number, column: number) => ({
  startLineNumber: line,
  startColumn: column,
  endLineNumber: line,
  endColumn: column
})

describe('parseLinkFragment', () => {
  it.each([
    ['L12', at(12, 1)],
    ['#L12', at(12, 1)],
    ['12', at(12, 1)],
    ['#12', at(12, 1)],
    ['L12,5', at(12, 5)],
    ['#L12,5', at(12, 5)],
    ['12:5', at(12, 5)],
    ['L12C5', at(12, 5)]
  ])('parses %s', (fragment, expected) => {
    expect(parseLinkFragment(fragment)).toEqual(expected)
  })

  it('parses ranges', () => {
    expect(parseLinkFragment('L3,2-L5,7')).toEqual({
      startLineNumber: 3,
      startColumn: 2,
      endLineNumber: 5,
      endColumn: 7
    })
    expect(parseLinkFragment('L3-L5')).toEqual({
      startLineNumber: 3,
      startColumn: 1,
      endLineNumber: 5,
      endColumn: 1
    })
  })

  it('rejects non-location fragments', () => {
    expect(parseLinkFragment('')).toBeNull()
    expect(parseLinkFragment('section-2')).toBeNull()
    expect(parseLinkFragment('L')).toBeNull()
  })

  it('clamps line 0 to 1', () => {
    expect(parseLinkFragment('L0')).toEqual(at(1, 1))
  })
})

describe('parseFileLink', () => {
  it('splits the URI and an (encoded) fragment', () => {
    expect(parseFileLink('file:///repo/a.ts#L10%2C18')).toEqual({
      uri: 'file:///repo/a.ts',
      range: at(10, 18)
    })
  })

  it('defaults to the start of the file', () => {
    expect(parseFileLink('file:///repo/a.ts')).toEqual({
      uri: 'file:///repo/a.ts',
      range: at(1, 1)
    })
    expect(parseFileLink('file:///repo/a.ts#intro')).toEqual({
      uri: 'file:///repo/a.ts',
      range: at(1, 1)
    })
  })
})
