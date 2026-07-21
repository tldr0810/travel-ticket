import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleCreateTrip } from '../../worker/routes/create-trip.mjs'
import { readStatus } from '../../worker/storage.mjs'

class MockKV {
  constructor() { this.store = new Map() }
  async put(key, value) { this.store.set(key, value) }
  async get(key, type) {
    if (!this.store.has(key)) return null
    const value = this.store.get(key)
    return type === 'json' ? JSON.parse(value) : value
  }
}

class MockWorkflow {
  constructor() { this.created = [] }
  async create(opts) { this.created.push(opts); return { id: opts.id } }
}

const makeEnv = () => ({ TRIPS_KV: new MockKV(), TRIPS_SITES: new MockKV(), TRIP_WORKFLOW: new MockWorkflow(), TURNSTILE_SECRET_KEY: 'sk_test' })

const VALID_BODY = { sentence: 'a relaxed week in Switzerland', visitor_id: 'visitor_abcdef01', turnstile_token: 'tok_ok' }

const withMockFetch = async (turnstileResult, fn) => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
    return { json: async () => turnstileResult }
  }
  try { await fn() } finally { globalThis.fetch = realFetch }
}

const req = (body) => new Request('https://example.com/api/trips', {
  method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' }, body: JSON.stringify(body),
})

test('handleCreateTrip: missing/invalid Turnstile token -> 403', async () => {
  await withMockFetch({ success: false }, async () => {
    const env = makeEnv()
    const res = await handleCreateTrip(req({ ...VALID_BODY, turnstile_token: 'bad' }), env)
    assert.equal(res.status, 403)
    assert.equal(env.TRIP_WORKFLOW.created.length, 0)
  })
})

test('handleCreateTrip: no turnstile_token at all -> 403 (never calls siteverify)', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('siteverify should not be called with no token') }
  try {
    const env = makeEnv()
    const { turnstile_token, ...noToken } = VALID_BODY
    const res = await handleCreateTrip(req(noToken), env)
    assert.equal(res.status, 403)
  } finally { globalThis.fetch = realFetch }
})

test('handleCreateTrip: valid token + valid body -> 201, workflow triggered, queued status written', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    const res = await handleCreateTrip(req(VALID_BODY), env)
    assert.equal(res.status, 201)
    const body = await res.json()
    assert.match(body.trip_id, /^trip_/)

    assert.equal(env.TRIP_WORKFLOW.created.length, 1)
    const { id, params } = env.TRIP_WORKFLOW.created[0]
    assert.equal(id, body.trip_id)
    assert.equal(params.tripId, body.trip_id)
    assert.equal(params.sentence, VALID_BODY.sentence)
    assert.equal(params.visitorId, VALID_BODY.visitor_id)
    assert.equal(typeof params.todayIso, 'string')
    assert.equal(params.design, undefined)

    const status = await readStatus(env, body.trip_id)
    assert.equal(status.phase, 'queued')
    assert.deepEqual(status.agents, {})
    assert.deepEqual(status.log, [])
    assert.equal(status.manifest, null)
    assert.equal(status.error, null)
  })
})

test('handleCreateTrip: an explicit design choice is passed through to the workflow', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    const res = await handleCreateTrip(req({ ...VALID_BODY, design: { kind: 'preset', name: 'japan' } }), env)
    assert.equal(res.status, 201)
    assert.deepEqual(env.TRIP_WORKFLOW.created[0].params.design, { kind: 'preset', name: 'japan' })
  })
})

test('handleCreateTrip: malformed design choice -> 400', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    const res = await handleCreateTrip(req({ ...VALID_BODY, design: { kind: 'nonsense' } }), env)
    assert.equal(res.status, 400)
    assert.equal(env.TRIP_WORKFLOW.created.length, 0)
  })
})

test('handleCreateTrip: oversized sentence -> 400', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    const res = await handleCreateTrip(req({ ...VALID_BODY, sentence: 'x'.repeat(501) }), env)
    assert.equal(res.status, 400)
    assert.equal(env.TRIP_WORKFLOW.created.length, 0)
  })
})

test('handleCreateTrip: empty sentence -> 400', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    const res = await handleCreateTrip(req({ ...VALID_BODY, sentence: '   ' }), env)
    assert.equal(res.status, 400)
  })
})

test('handleCreateTrip: malformed visitor_id (too short) -> 400', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    const res = await handleCreateTrip(req({ ...VALID_BODY, visitor_id: 'short' }), env)
    assert.equal(res.status, 400)
    assert.equal(env.TRIP_WORKFLOW.created.length, 0)
  })
})

test('handleCreateTrip: malformed visitor_id (bad characters) -> 400', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    const res = await handleCreateTrip(req({ ...VALID_BODY, visitor_id: 'has spaces!!' }), env)
    assert.equal(res.status, 400)
  })
})

test('handleCreateTrip: malformed JSON body -> 400', async () => {
  await withMockFetch({ success: true }, async () => {
    const env = makeEnv()
    const badReq = new Request('https://example.com/api/trips', { method: 'POST', body: 'not json' })
    const res = await handleCreateTrip(badReq, env)
    assert.equal(res.status, 400)
  })
})
