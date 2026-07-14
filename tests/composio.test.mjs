import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSse, mcpSession, composioEnabled } from '../pipeline/composio.mjs'

const sse = (obj) => `event: message\ndata: ${JSON.stringify(obj)}\n\n`
const okText = (inner) => sse({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify(inner) }] } })

// fake fetch: routes by body.method
const fakeFetch = (routes) => async (url, { body }) => {
  const req = JSON.parse(body)
  const route = routes[req.method] ?? (() => { throw new Error(`no route ${req.method}`) })
  return route(req)
}
const res = (text, { status = 200, headers = {} } = {}) => ({
  ok: status < 400, status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => text,
})

test('parseSse extracts last data line', () => {
  assert.deepEqual(parseSse('event: message\ndata: {"a":1}\n'), { a: 1 })
  assert.throws(() => parseSse('no sse here'))
})

test('composioEnabled reflects env', () => {
  const prev = process.env.COMPOSIO_API_KEY
  process.env.COMPOSIO_API_KEY = 'ck_test'
  assert.equal(composioEnabled(), true)
  delete process.env.COMPOSIO_API_KEY
  assert.equal(composioEnabled(), false)
  if (prev) process.env.COMPOSIO_API_KEY = prev
})

test('mcpSession handshake + callTool unwrap', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const fetchImpl = fakeFetch({
    initialize: () => res(okText({}), { headers: { 'mcp-session-id': 'sid-1' } }),
    'notifications/initialized': () => res(''),
    'tools/call': () => res(okText({ successful: true, data: { hello: 'world' } })),
  })
  const s = await mcpSession({ fetchImpl })
  assert.deepEqual(await s.callTool('X', {}), { hello: 'world' })
})

test('callTool throws when tool reports failure', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const fetchImpl = fakeFetch({
    initialize: () => res(okText({}), { headers: { 'mcp-session-id': 'sid-1' } }),
    'notifications/initialized': () => res(''),
    'tools/call': () => res(okText({ successful: false, error: 'no active connection' })),
  })
  const s = await mcpSession({ fetchImpl })
  await assert.rejects(() => s.callTool('X', {}), /no active connection/)
})

test('mcpSession surfaces 401 with stale-key hint', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const fetchImpl = fakeFetch({ initialize: () => res('{"error":"auth"}', { status: 401 }) })
  await assert.rejects(() => mcpSession({ fetchImpl }), /stale|dashboard/i)
})

test('execToolkitTool unwraps MULTI_EXECUTE result item', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  let captured
  const fetchImpl = fakeFetch({
    initialize: () => res(okText({}), { headers: { 'mcp-session-id': 'sid-1' } }),
    'notifications/initialized': () => res(''),
    'tools/call': (req) => {
      captured = req.params
      return res(okText({ successful: true, data: { results: [{ tool_slug: 'GMAIL_FETCH_EMAILS', index: 0, response: { successful: true, data: { messages: [] } } }], total_count: 1, success_count: 1, error_count: 0 } }))
    },
  })
  const s = await mcpSession({ fetchImpl })
  const out = await s.execToolkitTool('GMAIL_FETCH_EMAILS', { query: 'x' })
  assert.equal(captured.name, 'COMPOSIO_MULTI_EXECUTE_TOOL')
  assert.equal(captured.arguments.tools[0].tool_slug, 'GMAIL_FETCH_EMAILS')
  assert.deepEqual(out, { messages: [] })
})

test('execToolkitTool rejects when result item response fails', async () => {
  process.env.COMPOSIO_API_KEY = 'ck_test'
  const fetchImpl = fakeFetch({
    initialize: () => res(okText({}), { headers: { 'mcp-session-id': 'sid-1' } }),
    'notifications/initialized': () => res(''),
    'tools/call': () => res(okText({ successful: true, data: { results: [{ tool_slug: 'GMAIL_FETCH_EMAILS', index: 0, response: { successful: false, error: 'no active connection' } }], total_count: 1, success_count: 0, error_count: 1 } })),
  })
  const s = await mcpSession({ fetchImpl })
  await assert.rejects(() => s.execToolkitTool('GMAIL_FETCH_EMAILS', { query: 'x' }), /no active connection/)
})
