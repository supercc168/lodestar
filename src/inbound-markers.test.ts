import { describe, expect, test } from 'bun:test'

import { parseInboundMarker } from './inbound-markers'

describe('inbound multi-message markers', () => {
  describe('start marker (≥3 `>`)', () => {
    test('exactly three > triggers start with empty body', () => {
      expect(parseInboundMarker('>>>')).toEqual({ marker: 'start', body: '' })
    })
    test('four > triggers start, body kept', () => {
      expect(parseInboundMarker('>>>>first')).toEqual({ marker: 'start', body: 'first' })
    })
    test('strips exactly one space after the marker run', () => {
      expect(parseInboundMarker('>>> hello world')).toEqual({ marker: 'start', body: 'hello world' })
    })
    test('preserves additional leading whitespace beyond one space', () => {
      // marker 吃一个空格,第二个空格是用户内容,保留
      expect(parseInboundMarker('>>>  indented')).toEqual({ marker: 'start', body: ' indented' })
    })
    test('two > is NOT a marker (markdown nested-quote safe)', () => {
      expect(parseInboundMarker('>> text')).toEqual({ marker: 'none', body: '>> text' })
    })
    test('single blockquote > is NOT a marker', () => {
      expect(parseInboundMarker('> quote')).toEqual({ marker: 'none', body: '> quote' })
    })
  })

  describe('end marker (≥3 `<`)', () => {
    test('exactly three < triggers end with empty body', () => {
      expect(parseInboundMarker('<<<')).toEqual({ marker: 'end', body: '' })
    })
    test('four < triggers end, body kept', () => {
      expect(parseInboundMarker('<<<<last segment')).toEqual({ marker: 'end', body: 'last segment' })
    })
    test('strips one space after end marker', () => {
      expect(parseInboundMarker('<<< done')).toEqual({ marker: 'end', body: 'done' })
    })
  })

  test('marker only recognized at the very start of the message', () => {
    expect(parseInboundMarker('text >>>')).toEqual({ marker: 'none', body: 'text >>>' })
    expect(parseInboundMarker(' leading <<<')).toEqual({ marker: 'none', body: ' leading <<<' })
  })

  test('mixed arrow runs like >><< are NOT markers', () => {
    expect(parseInboundMarker('>><<')).toEqual({ marker: 'none', body: '>><<' })
  })

  test('empty / plain text passes through unchanged', () => {
    expect(parseInboundMarker('')).toEqual({ marker: 'none', body: '' })
    expect(parseInboundMarker('hello world')).toEqual({ marker: 'none', body: 'hello world' })
  })

  test('multiline body after marker is preserved', () => {
    expect(parseInboundMarker('>>>line1\nline2')).toEqual({ marker: 'start', body: 'line1\nline2' })
  })
})
