import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleFetch } from '../../worker/index.mjs'
import { saveTripFiles } from '../../worker/storage.mjs'

class MockKV {
  constructor() { this.store = new Map() }
  async put(key, value) { this.store.set(key, value) }
  async get(key, type) {
    if (!this.store.has(key)) return null
    const value = this.store.get(key)
    if (type === 'json') return JSON.parse(value)
    if (type === 'arrayBuffer') return typeof value === 'string' ? new TextEncoder().encode(value).buffer : value
    return value
  }
}

const makeEnv = () => ({
  TRIPS_KV: new MockKV(),
  TRIPS_SITES: new MockKV(),
  TRIP_WORKFLOW: { create: async (opts) => ({ id: opts.id }) },
  TURNSTILE_SECRET_KEY: 'sk_test',
  ASSETS: { fetch: async () => new Response('app shell', { status: 200 }) },
})

test('handleFetch: unknown API path -> 404 JSON', async () => {
  const env = makeEnv()
  const res = await handleFetch(new Request('https://example.com/api/nonsense'), env)
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
})

test('handleFetch: GET /api/trips/:id/status with wrong method -> 405', async () => {
  const env = makeEnv()
  const res = await handleFetch(new Request('https://example.com/api/trips/trip_x/status', { method: 'POST' }), env)
  assert.equal(res.status, 405)
})

test('handleFetch: GET /api/trips/:id/status routes to handleTripStatus (404 for unknown trip)', async () => {
  const env = makeEnv()
  const res = await handleFetch(new Request('https://example.com/api/trips/trip_unknown/status'), env)
  assert.equal(res.status, 404)
})

test('handleFetch: POST /api/trips/:id/connect/:provider/link routes correctly', async () => {
  const env = makeEnv({ })
  env.COMPOSIO_API_KEY = undefined // no key configured -> configuration_required, but still a 200 (route reached)
  const res = await handleFetch(
    new Request('https://example.com/api/trips/trip_x/connect/gmail/link?visitor_id=visitor_abcdef01', { method: 'POST' }),
    env,
  )
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.connector, 'gmail')
})

test('handleFetch: GET /api/trips/:id/connect/:provider/status routes correctly', async () => {
  const env = makeEnv()
  const res = await handleFetch(
    new Request('https://example.com/api/trips/trip_x/connect/gmail/status?visitor_id=visitor_abcdef01'),
    env,
  )
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(typeof body.connected, 'boolean')
})

test('handleFetch: GET /trips/<unknown>/ -> 404', async () => {
  const env = makeEnv()
  const res = await handleFetch(new Request('https://example.com/trips/no-such-trip/'), env)
  assert.equal(res.status, 404)
})

test('handleFetch: GET /trips/<known>/ -> 200 index.html with text/html content-type', async () => {
  const env = makeEnv()
  await saveTripFiles(env, 'trip_known', new Map([['index.html', '<html><body>hi</body></html>']]))
  const res = await handleFetch(new Request('https://example.com/trips/trip_known/'), env)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
})

test('handleFetch: GET /trips/<known> (no trailing slash) also serves index.html', async () => {
  const env = makeEnv()
  await saveTripFiles(env, 'trip_known', new Map([['index.html', '<html></html>']]))
  const res = await handleFetch(new Request('https://example.com/trips/trip_known'), env)
  assert.equal(res.status, 200)
})

test('handleFetch: GET /trips/<known>/manifest.webmanifest -> correct content-type', async () => {
  const env = makeEnv()
  await saveTripFiles(env, 'trip_known', new Map([['manifest.webmanifest', '{}']]))
  const res = await handleFetch(new Request('https://example.com/trips/trip_known/manifest.webmanifest'), env)
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'application/manifest+json; charset=utf-8')
})

test('handleFetch: unmatched path falls through to the ASSETS binding (static app-shell)', async () => {
  const env = makeEnv()
  const res = await handleFetch(new Request('https://example.com/connect.html'), env)
  assert.equal(res.status, 200)
  assert.equal(await res.text(), 'app shell')
})

test('handleFetch: bare / falls through to the ASSETS binding', async () => {
  const env = makeEnv()
  const res = await handleFetch(new Request('https://example.com/'), env)
  assert.equal(await res.text(), 'app shell')
})
