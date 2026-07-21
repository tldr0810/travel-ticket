import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleConnectLink, handleConnectStatus } from '../../worker/routes/connect.mjs'

const VISITOR = 'visitor_abcdef01'
const makeEnv = (overrides = {}) => ({
  COMPOSIO_API_KEY: 'ck_test', COMPOSIO_GMAIL_AUTH_CONFIG_ID: 'ac_gmail', ...overrides,
})
const req = (visitorId = VISITOR) => new Request(`https://example.com/api/trips/trip_x/connect/gmail/link?visitor_id=${visitorId}`)

test('handleConnectLink: returns an authorization_url from a mocked Composio client', async () => {
  const env = makeEnv()
  const client = { connectedAccounts: { link: async () => ({ id: 'cr_1', redirectUrl: 'https://connect.example/link' }) } }
  const res = await handleConnectLink(req(), env, 'trip_x', 'gmail', { client })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.authorization_url, 'https://connect.example/link')
  assert.equal(body.status, 'authorization_required')
  assert.equal(body.visitor_id, VISITOR)
})

test('handleConnectLink: missing auth config -> configuration_required, never calls link()', async () => {
  const env = makeEnv({ COMPOSIO_GMAIL_AUTH_CONFIG_ID: undefined })
  let called = false
  const client = { connectedAccounts: { link: async () => { called = true; return {} } } }
  const res = await handleConnectLink(req(), env, 'trip_x', 'gmail', { client })
  const body = await res.json()
  assert.equal(body.status, 'configuration_required')
  assert.equal(called, false)
})

test('handleConnectLink: missing visitor_id -> 400', async () => {
  const env = makeEnv()
  const res = await handleConnectLink(req(''), env, 'trip_x', 'gmail', {})
  assert.equal(res.status, 400)
})

test('handleConnectLink: unknown connector -> 400', async () => {
  const env = makeEnv()
  const res = await handleConnectLink(req(), env, 'trip_x', 'not-a-real-connector', {})
  assert.equal(res.status, 400)
})

test('handleConnectStatus: connected account -> {connected:true}', async () => {
  const env = makeEnv()
  const client = { connectedAccounts: { list: async () => ({ items: [{ id: 'ca_1', alias: null, status: 'ACTIVE' }] }) } }
  const res = await handleConnectStatus(req(), env, 'trip_x', 'gmail', { client })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.connected, true)
  assert.equal(body.status, 'connected')
})

test('handleConnectStatus: no connected account -> {connected:false}', async () => {
  const env = makeEnv()
  const client = { connectedAccounts: { list: async () => ({ items: [] }) } }
  const res = await handleConnectStatus(req(), env, 'trip_x', 'gmail', { client })
  const body = await res.json()
  assert.equal(body.connected, false)
  assert.equal(body.status, 'not_connected')
})

test('handleConnectStatus: no Composio API key configured -> configuration_required, connected:false', async () => {
  const env = makeEnv({ COMPOSIO_API_KEY: undefined })
  const res = await handleConnectStatus(req(), env, 'trip_x', 'gmail', {})
  const body = await res.json()
  assert.equal(body.connected, false)
  assert.equal(body.status, 'configuration_required')
})

test('handleConnectStatus: malformed visitor_id -> 400', async () => {
  const env = makeEnv()
  const res = await handleConnectStatus(req('short'), env, 'trip_x', 'gmail', {})
  assert.equal(res.status, 400)
})
