import { describe, expect, test } from 'bun:test'

import { extractSendMarkerPaths } from './outbound-markers'

describe('outbound send markers', () => {
  test('extracts paths that contain square brackets', () => {
    const text = '[[send: /home/leviyuan/mmo[avatar]/client/assets/avatar_demo/avatar_contact_sheet.png]]'

    expect(extractSendMarkerPaths(text)).toEqual([
      '/home/leviyuan/mmo[avatar]/client/assets/avatar_demo/avatar_contact_sheet.png',
    ])
  })

  test('extracts multiple markers and trims marker padding', () => {
    const text = [
      'first [[send:  /tmp/a.png  ]]',
      'second [[send: /tmp/out[1].jpg]]',
    ].join('\n')

    expect(extractSendMarkerPaths(text)).toEqual([
      '/tmp/a.png',
      '/tmp/out[1].jpg',
    ])
  })

  test('does not match markers split across lines', () => {
    expect(extractSendMarkerPaths('[[send: /tmp/a.png\n]]')).toEqual([])
  })
})
