import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTravelContextAgent } from '../pipeline/agents.mjs'

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
