import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleTripStatus } from '../../worker/routes/status.mjs'
import { writeStatus } from '../../worker/storage.mjs'

class MockKV {
  constructor() { this.store = new Map() }
  async put(key, value) { this.store.set(key, value) }
  async get(key, type) {
    if (!this.store.has(key)) return null
    const value = this.store.get(key)
    return type === 'json' ? JSON.parse(value) : value
  }
}

const makeEnv = () => ({ TRIPS_KV: new MockKV() })
const req = () => new Request('https://example.com/api/trips/trip_x/status')

test('handleTripStatus: unknown trip_id -> 404', async () => {
  const env = makeEnv()
  const res = await handleTripStatus(req(), env, 'trip_does_not_exist')
  assert.equal(res.status, 404)
})

test('handleTripStatus: known trip_id -> 200 with the exact {phase,agents,log,manifest,error} shape', async () => {
  const env = makeEnv()
  const written = {
    phase: 'running',
    trip_id: 'trip_abc',
    agents: { 'Trip Brief Agent': 'completed' },
    log: ['Trip Brief Agent: Completed in 2s.'],
    manifest: null,
    error: null,
  }
  await writeStatus(env, 'trip_abc', written)

  const res = await handleTripStatus(req(), env, 'trip_abc')
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.deepEqual(body, written)
})
