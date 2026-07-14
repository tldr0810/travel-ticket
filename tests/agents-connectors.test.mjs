import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTravelContextAgent, runCalendarAgent, runNotionAgent } from '../pipeline/agents.mjs'

const BRIEF = { destination: 'Japan: Kyoto & Osaka', start_date: '2026-09-10', end_date: '2026-09-13' }

test('gmail agent skips without COMPOSIO_API_KEY', async () => {
  delete process.env.COMPOSIO_API_KEY
  const r = await runTravelContextAgent(null, BRIEF)
  assert.equal(r.status, 'skipped')
  assert.deepEqual(r.bookings, [])
})

test('gmail agent: session error → skipped with reason', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const r = await runTravelContextAgent(null, BRIEF, { session: () => Promise.reject(new Error('HTTP 401 — stale')) })
  assert.equal(r.status, 'skipped')
  assert.match(r.notes, /401/)
})

test('gmail agent: empty inbox → ok + empty bookings', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const session = { execToolkitTool: async () => ({ messages: [] }) }
  const r = await runTravelContextAgent(null, BRIEF, { session: async () => session })
  assert.equal(r.status, 'ok')
  assert.deepEqual(r.bookings, [])
})

test('gmail agent: extracts bookings via injected llm', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const calls = []
  const session = {
    execToolkitTool: async (slug, args) => {
      calls.push(slug)
      if (slug === 'GMAIL_FETCH_EMAILS') return { messages: [{ messageId: 'm1', subject: 'Your booking', sender: 'jr@example.com', preview: {} }] }
      if (slug === 'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID') return { subject: 'Your booking', messageText: 'JR pass confirmation ABC123 2026-09-10' }
      throw new Error(`unexpected ${slug}`)
    },
  }
  const llm = async () => ({ bookings: [{ type: 'train', vendor: 'JR', confirmation_no: 'ABC123', start: '2026-09-10', end: '', location: 'Kyoto', pax: 2 }] })
  const r = await runTravelContextAgent(null, BRIEF, { session: async () => session, llm })
  assert.equal(r.status, 'ok')
  assert.equal(r.bookings.length, 1)
  assert.ok(calls.includes('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID'))
})

test('gmail agent: llm garbage twice → ok + empty bookings (no bad data downstream)', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const session = {
    execToolkitTool: async (slug) => slug === 'GMAIL_FETCH_EMAILS'
      ? { messages: [{ messageId: 'm1', subject: 's', sender: 'x' }] }
      : { subject: 's', messageText: 'body' },
  }
  let n = 0
  const llm = async () => { n++; throw new Error('bad json') }
  const r = await runTravelContextAgent(null, BRIEF, { session: async () => session, llm })
  assert.equal(n, 2) // one retry
  assert.equal(r.status, 'ok')
  assert.deepEqual(r.bookings, [])
})

test('calendar agent skips without key', async () => {
  delete process.env.COMPOSIO_API_KEY
  const r = await runCalendarAgent(null, BRIEF)
  assert.equal(r.status, 'skipped')
})

test('calendar agent maps events deterministically', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  let captured
  const session = {
    execToolkitTool: async (slug, args) => {
      captured = { slug, args }
      return { items: [
        { summary: 'Board meeting', start: { dateTime: '2026-09-11T09:00:00+09:00' }, end: { dateTime: '2026-09-11T10:00:00+09:00' } },
        { summary: 'Holiday', start: { date: '2026-09-12' }, end: { date: '2026-09-13' } },
      ] }
    },
  }
  const r = await runCalendarAgent(null, BRIEF, { session: async () => session })
  assert.equal(captured.slug, 'GOOGLECALENDAR_EVENTS_LIST')
  assert.equal(captured.args.timeMin, '2026-09-10T00:00:00Z')
  assert.equal(r.status, 'ok')
  assert.equal(r.events.length, 2)
  assert.equal(r.events[1].all_day, true)
})

test('calendar agent: tool error → skipped', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const session = { execToolkitTool: async () => { throw new Error('no active connection') } }
  const r = await runCalendarAgent(null, BRIEF, { session: async () => session })
  assert.equal(r.status, 'skipped')
  assert.match(r.notes, /no active connection/)
})

test('notion agent skips without key', async () => {
  delete process.env.COMPOSIO_API_KEY
  const r = await runNotionAgent(null, BRIEF)
  assert.equal(r.status, 'skipped')
  assert.deepEqual(r.travel_notes, [])
})

test('notion agent: no connection error → skipped honestly', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const session = { execToolkitTool: async () => { throw new Error('notion: no active connection') } }
  const r = await runNotionAgent(null, BRIEF, { session: async () => session })
  assert.equal(r.status, 'skipped')
})

test('notion agent: search→markdown→llm extraction', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const session = {
    execToolkitTool: async (slug) => {
      if (slug === 'NOTION_SEARCH_NOTION_PAGE') return { results: [{ id: 'p1', title: 'Kyoto trip notes' }] }
      if (slug === 'NOTION_GET_PAGE_MARKDOWN') return { markdown: '# Kyoto\n- 想吃:一蘭拉麵\n' }
      throw new Error(`unexpected ${slug}`)
    },
  }
  const llm = async () => ({ travel_notes: [{ title: '一蘭拉麵', note: '想吃', location: 'Kyoto', url: '', category: 'meal' }] })
  const r = await runNotionAgent(null, BRIEF, { session: async () => session, llm })
  assert.equal(r.status, 'ok')
  assert.equal(r.travel_notes.length, 1)
})

test('notion agent: zero pages → ok + empty', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const session = { execToolkitTool: async () => ({ results: [] }) }
  const r = await runNotionAgent(null, BRIEF, { session: async () => session })
  assert.equal(r.status, 'ok')
  assert.deepEqual(r.travel_notes, [])
})
