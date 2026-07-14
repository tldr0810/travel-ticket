import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderItinerary } from '../pipeline/render.mjs'

const MIN_ITIN = {
  artifact_type: 'final_itinerary', trip_id: 'trip_test_abcd', destination: 'Testland',
  slug: 'testland-2026', destination_timezone: 'UTC', home_timezone: 'UTC',
  travellers: 1, summary: 's', warnings: [], sources: [], days: [], alternatives: {},
  actions_suggested: [], cover: { title_top: 'Test', title_accent: 'Trip' },
  context: { bookings: [], calendar_events: [] },
}

test('customTokens are injected after theme css', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'))
  renderItinerary(MIN_ITIN, { outDir: dir, customTokens: { rail: '#123456', night: '#0a0b0c' } })
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
  assert.ok(html.includes('--rail:#123456'))
  assert.ok(html.includes('--night:#0a0b0c'))
})

test('no customTokens → no injection (regression)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'))
  renderItinerary(MIN_ITIN, { outDir: dir })
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
  assert.ok(!html.includes('--rail:#123456'))
})
