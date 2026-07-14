// Zero-dep client for Composio's dynamic-tools MCP server. The ONLY file in the
// pipeline that speaks the MCP protocol. Never calls COMPOSIO_MANAGE_CONNECTIONS
// (it side-effect-spawns pending connections) — connection problems surface as
// tool errors and the caller degrades to skip.
const MCP_URL = 'https://connect.composio.dev/mcp'
const DEFAULT_TIMEOUT_MS = 20_000

export const composioEnabled = () => Boolean(process.env.COMPOSIO_API_KEY)

export const parseSse = (text) => {
  const lines = String(text).split('\n').filter((l) => l.startsWith('data: '))
  if (!lines.length) throw new Error('no SSE data line in MCP response')
  return JSON.parse(lines.at(-1).slice(6))
}

let idCounter = 1

const post = (body, { key, sessionId, timeoutMs, fetchImpl }) => fetchImpl(MCP_URL, {
  method: 'POST',
  headers: {
    'x-consumer-api-key': key,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(timeoutMs),
})

export async function mcpSession({ timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const key = process.env.COMPOSIO_API_KEY
  if (!key) throw new Error('COMPOSIO_API_KEY not set')
  const opts = { key, timeoutMs, fetchImpl }
  const initRes = await post({
    jsonrpc: '2.0', id: idCounter++, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'trip-ticket-pipeline', version: '0.1.0' } },
  }, opts)
  if (!initRes.ok) {
    throw new Error(`MCP initialize failed: HTTP ${initRes.status}${initRes.status === 401
      ? ' — COMPOSIO_API_KEY looks stale; the dashboard is the source of truth, copy the current key from it'
      : ''}`)
  }
  const sessionId = initRes.headers.get('mcp-session-id')
  if (!sessionId) throw new Error('MCP initialize returned no mcp-session-id header')
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { ...opts, sessionId })

  const callTool = async (name, args) => {
    const res = await post({
      jsonrpc: '2.0', id: idCounter++, method: 'tools/call',
      params: { name, arguments: args },
    }, { ...opts, sessionId })
    if (!res.ok) throw new Error(`MCP tools/call ${name}: HTTP ${res.status}`)
    const rpc = parseSse(await res.text())
    if (rpc.error) throw new Error(`MCP tools/call ${name}: ${rpc.error.message}`)
    const text = rpc.result?.content?.[0]?.text
    if (text == null) throw new Error(`MCP tools/call ${name}: empty content`)
    const inner = JSON.parse(text)
    if (inner.successful === false) throw new Error(`${name}: ${inner.error || 'tool reported failure'}`)
    return inner.data ?? inner
  }

  const execToolkitTool = async (slug, args, { account } = {}) => {
    const data = await callTool('COMPOSIO_MULTI_EXECUTE_TOOL', {
      tools: [{ tool_slug: slug, arguments: args, ...(account ? { account } : {}) }],
      thought: `trip-ticket pipeline: ${slug}`,
      current_step: slug,
    })
    const item = Array.isArray(data?.results) ? data.results[0] : data
    const payload = item?.response ?? item
    if (payload?.successful === false || payload?.error) throw new Error(`${slug}: ${payload.error || 'execution failed'}`)
    return payload?.data ?? payload
  }

  return { callTool, execToolkitTool }
}
