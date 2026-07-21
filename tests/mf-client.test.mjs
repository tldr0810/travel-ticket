import { test } from 'node:test'
import assert from 'node:assert/strict'
import { callMfAgent, extractAgentText, runMfJson } from '../pipeline/mf-client.mjs'

const ENV = { MF_API_URL: 'https://api-staging.manyfold.ai/api', MF_API_TOKEN: 'self-token', MF_AGENT_ID: 'agt_self' }

function withFetch(handler, fn) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return fn().finally(() => { globalThis.fetch = original })
}

test('callMfAgent: mints a peer token then posts JSON-RPC message/send', () => withFetch(async (url, opts) => {
  if (String(url).includes('/a2a/peers/')) {
    assert.match(String(url), /\/agent-self\/a2a\/peers\/agt_peer\/token\?agentId=agt_self$/)
    assert.equal(opts.headers.authorization, 'Bearer self-token')
    return new Response(JSON.stringify({ token: 'peer-token', rpcUrl: 'https://rpc.example/agt_peer' }), { status: 200 })
  }
  assert.equal(url, 'https://rpc.example/agt_peer')
  assert.equal(opts.headers.authorization, 'Bearer peer-token')
  const body = JSON.parse(opts.body)
  assert.equal(body.method, 'message/send')
  assert.equal(body.params.message.parts[0].text, 'hello')
  return new Response(JSON.stringify({ result: { parts: [{ text: 'world' }] } }), { status: 200 })
}, async () => {
  const text = await callMfAgent(ENV, 'agt_peer', 'hello')
  assert.equal(text, 'world')
}))

test('callMfAgent: retries once on 5xx then succeeds', () => withFetch((() => {
  let calls = 0
  return async (url) => {
    if (String(url).includes('/token')) return new Response(JSON.stringify({ token: 't', rpcUrl: 'https://rpc.example/x' }), { status: 200 })
    calls++
    if (calls === 1) return new Response('boom', { status: 502 })
    return new Response(JSON.stringify({ result: { parts: [{ text: 'ok' }] } }), { status: 200 })
  }
})(), async () => {
  const text = await callMfAgent(ENV, 'agt_peer', 'hello')
  assert.equal(text, 'ok')
}))

test('callMfAgent: 4xx fails fast, no retry', () => withFetch((() => {
  let rpcCalls = 0
  return async (url) => {
    if (String(url).includes('/token')) return new Response(JSON.stringify({ token: 't', rpcUrl: 'https://rpc.example/x' }), { status: 200 })
    rpcCalls++
    return new Response('bad request', { status: 400 })
  }
})(), async () => {
  await assert.rejects(() => callMfAgent(ENV, 'agt_peer', 'hello'), /400/)
}))

test('callMfAgent: task state failed → throws with extracted detail', () => withFetch(async (url) => {
  if (String(url).includes('/token')) return new Response(JSON.stringify({ token: 't', rpcUrl: 'https://rpc.example/x' }), { status: 200 })
  return new Response(JSON.stringify({ result: { status: { state: 'failed', message: { parts: [{ text: 'agent crashed' }] } } } }), { status: 200 })
}, async () => {
  await assert.rejects(() => callMfAgent(ENV, 'agt_peer', 'hello', { attempts: 1 }), /agent crashed/)
}))

test('extractAgentText: prefers result.parts, then artifacts, then status.message', () => {
  assert.equal(extractAgentText({ result: { parts: [{ text: 'a' }] } }), 'a')
  assert.equal(extractAgentText({ result: { artifacts: [{ parts: [{ text: 'b1' }] }, { parts: [{ text: 'b2' }] }] } }), 'b1\nb2')
  assert.equal(extractAgentText({ result: { status: { message: { parts: [{ text: 'c' }] } } } }), 'c')
  assert.equal(extractAgentText({}), '{}')
})

test('runMfJson: injects schema instructions into the prompt and parses the JSON reply', () => withFetch(async (url, opts) => {
  if (String(url).includes('/token')) return new Response(JSON.stringify({ token: 't', rpcUrl: 'https://rpc.example/x' }), { status: 200 })
  const body = JSON.parse(opts.body)
  const sentPrompt = body.params.message.parts[0].text
  assert.match(sentPrompt, /system prompt/)
  assert.match(sentPrompt, /JSON Schema/)
  return new Response(JSON.stringify({ result: { parts: [{ text: '```json\n{"ok":true}\n```' }] } }), { status: 200 })
}, async () => {
  const parsed = await runMfJson(ENV, 'agt_peer', { system: 'system prompt', prompt: 'do the thing', schema: { type: 'object' } })
  assert.deepEqual(parsed, { ok: true })
}))

test('runMfJson: throws when reply has no JSON object', () => withFetch(async (url) => {
  if (String(url).includes('/token')) return new Response(JSON.stringify({ token: 't', rpcUrl: 'https://rpc.example/x' }), { status: 200 })
  return new Response(JSON.stringify({ result: { parts: [{ text: 'no json here' }] } }), { status: 200 })
}, async () => {
  await assert.rejects(() => runMfJson(ENV, 'agt_peer', { system: 's', prompt: 'p', schema: {} }), /no JSON object/)
}))
