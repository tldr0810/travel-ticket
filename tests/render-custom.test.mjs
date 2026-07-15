import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderItinerary } from '../pipeline/render.mjs'

const renderedHtml = (dir) => fs.readdirSync(dir)
  .filter((file) => file.endsWith('.html'))
  .map((file) => fs.readFileSync(path.join(dir, file), 'utf8'))
  .join('\n')

const MIN_ITIN = {
  artifact_type: 'final_itinerary', trip_id: 'trip_test_abcd', destination: 'Testland',
  slug: 'testland-2026', destination_timezone: 'UTC', home_timezone: 'UTC',
  travellers: 1, summary: 's', warnings: [], sources: [], alternatives: {},
  actions_suggested: [], cover: { title_top: 'Test', title_accent: 'Trip' },
  context: { bookings: [], calendar_events: [] },
  days: [{
    date: '2026-01-01', title: 'Test → Testland', base: 'Testland',
    items: [{ variant: 'both', type: 'visit', title: 'Test stop', start_utc: '2026-01-01T10:00:00Z', end_utc: '2026-01-01T11:00:00Z', location: 'Testland', notes: '', sources: [] }],
  }],
}

test('customTokens are injected after theme css', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'))
  renderItinerary(MIN_ITIN, { outDir: dir, customTokens: { rail: '#123456', night: '#0a0b0c' } })
  const html = renderedHtml(dir)
  assert.ok(html.includes('--rail:#123456'))
  assert.ok(html.includes('--night:#0a0b0c'))
})

test('no customTokens → no injection (regression)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'))
  renderItinerary(MIN_ITIN, { outDir: dir })
  const html = renderedHtml(dir)
  assert.ok(!html.includes('--rail:#123456'))
})

test('custom postmark motif is escaped for SVG and its generated JS literal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'))
  const attack = "MARK</script><script>globalThis.injected='yes'</script>'\\\\slash"
  const escaped = attack.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]))
  renderItinerary(MIN_ITIN, {
    outDir: dir,
    customMotifs: { stampText: attack, eyebrow: attack },
  })
  const html = renderedHtml(dir)

  assert.ok(!html.includes(attack))
  assert.ok(!html.includes("globalThis.injected='yes'"))
  assert.ok(html.includes(` + ${JSON.stringify(escaped)} + '</text>'`))
  assert.ok(html.includes(`<div class="eyebrow">${escaped}</div>`))

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
  assert.ok(scripts.length > 0)
  for (const script of scripts) assert.doesNotThrow(() => new Function(script))
})
