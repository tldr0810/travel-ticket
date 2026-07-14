import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { customTokensFrom } from '../pipeline/trip.mjs'
import { renderItinerary } from '../pipeline/render.mjs'

const GOOD_TOKENS = { // japan's palette: known to pass all 13 pairs (tests/custom-theme.test.mjs)
  rail: '#0b7d6e', 'rail-deep': '#0a5648', 'rail-press': '#0a5648', stamp: '#a62812',
  night: '#123a33', gold: '#f8b500', green: '#3a6b2f', blue: '#165e83',
  board: '#0f231f', 'board-hi': '#1a3029', 'board-lo': '#081310', 'board-edge': '#040a08',
}

const MIN_ITIN = {
  artifact_type: 'final_itinerary', trip_id: 'trip_test_abcd', destination: 'Testland',
  slug: 'testland-2026', destination_timezone: 'UTC', home_timezone: 'UTC',
  travellers: 1, summary: 's', warnings: [], sources: [], days: [], alternatives: {},
  actions_suggested: [], cover: { title_top: 'Test', title_accent: 'Trip' },
  context: { bookings: [], calendar_events: [] },
}

test('customTokensFrom returns the tokens for a valid custom_theme', () => {
  const itin = { ...MIN_ITIN, custom_theme: { name: 'kyoto-teal', rationale: 'JR teal', tokens: GOOD_TOKENS } }
  const tokens = customTokensFrom(itin)
  assert.deepEqual(tokens, GOOD_TOKENS)
})

test('customTokensFrom returns null for a tampered key', () => {
  const itin = { ...MIN_ITIN, custom_theme: { name: 'x', tokens: { ...GOOD_TOKENS, paper: '#000000' } } }
  assert.equal(customTokensFrom(itin), null)
})

test('customTokensFrom returns null for a tampered value', () => {
  const itin = { ...MIN_ITIN, custom_theme: { name: 'x', tokens: { ...GOOD_TOKENS, rail: 'red; } body{display:none' } } }
  assert.equal(customTokensFrom(itin), null)
})

test('customTokensFrom returns null when custom_theme is absent', () => {
  assert.equal(customTokensFrom(MIN_ITIN), null)
})

test('end-to-end: renderItinerary with customTokensFrom(itin) output contains --rail:', () => {
  const itin = { ...MIN_ITIN, custom_theme: { name: 'kyoto-teal', tokens: GOOD_TOKENS } }
  const tokens = customTokensFrom(itin)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-only-'))
  renderItinerary(itin, { outDir: dir, customTokens: tokens })
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
  assert.ok(html.includes('--rail:'))
})
