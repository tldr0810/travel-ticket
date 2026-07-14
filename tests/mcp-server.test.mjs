import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// helper: spawn server, send messages, collect responses by id
function rpcSession() {
  const child = spawn('node', [path.join(ROOT, 'pipeline/mcp-server.mjs')], { env: { ...process.env, TRIP_NO_LLM: '1' } })
  let buf = ''
  const pending = new Map()
  child.stdout.on('data', (d) => {
    buf += d
    let idx
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx); buf = buf.slice(idx + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
    }
  })
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n')
  const request = (msg) => new Promise((resolve) => { pending.set(msg.id, resolve); send(msg) })
  return { child, send, request, kill: () => child.kill() }
}

test('initialize → tools/list shows plan_trip + render_ticket', async () => {
  const s = rpcSession()
  try {
    const init = await s.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    assert.equal(init.result.protocolVersion, '2024-11-05')
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const list = await s.request({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const names = list.result.tools.map((t) => t.name)
    assert.ok(names.includes('plan_trip'))
    assert.ok(names.includes('render_ticket'))
  } finally { s.kill() }
})

test('unknown method → -32601', async () => {
  const s = rpcSession()
  try {
    const r = await s.request({ jsonrpc: '2.0', id: 3, method: 'bogus/method' })
    assert.equal(r.error.code, -32601)
  } finally { s.kill() }
})

test('plan_trip (mock) → render_ticket round-trip', async () => {
  const s = rpcSession()
  try {
    await s.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const planRes = await s.request({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'plan_trip', arguments: { sentence: '', mock: true } } })
    const planOut = JSON.parse(planRes.result.content[0].text)
    assert.ok(planOut.plan_id)
    assert.ok(planOut.design_options.presets.length >= 1)
    const renderRes = await s.request({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'render_ticket', arguments: { plan_id: planOut.plan_id, design: 'japan' } } })
    const renderOut = JSON.parse(renderRes.result.content[0].text)
    assert.equal(renderOut.theme_used.name, 'japan')
    assert.ok(renderOut.entry.endsWith('index.html'))
  } finally { s.kill() }
})

test('render_ticket with unknown plan_id → isError', async () => {
  const s = rpcSession()
  try {
    await s.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const r = await s.request({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'render_ticket', arguments: { plan_id: 'nope' } } })
    assert.equal(r.result.isError, true)
  } finally { s.kill() }
})
