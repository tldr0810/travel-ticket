// Manyfold A2A client — calls a Manyfold platform agent as the pipeline's LLM
// backend. Fetch-based only (no Node builtins) so it runs unchanged in a
// Cloudflare Worker or in local Node. Mirrors article-lens's src/crew/mf.ts:
//   1. mint a short-lived per-peer bearer:
//        POST {MF_API_URL}/agent-self/a2a/peers/{peerId}/token   (Bearer = MF_API_TOKEN)
//        → { token, rpcUrl, expiresAt }
//   2. call the peer's rpcUrl with that bearer using JSON-RPC message/send.
// Minted tokens are cached per peer (~15 min) so repeated calls in one run
// reuse a token instead of minting every time.

const tokenCache = new Map()

async function getPeerToken(env, peerId) {
  const cached = tokenCache.get(peerId)
  if (cached && cached.exp > Date.now() + 30_000) return cached

  const q = env.MF_AGENT_ID ? `?agentId=${encodeURIComponent(env.MF_AGENT_ID)}` : ''
  const res = await fetch(`${env.MF_API_URL}/agent-self/a2a/peers/${encodeURIComponent(peerId)}/token${q}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.MF_API_TOKEN}`, accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`peer token mint failed: ${res.status} ${await res.text()}`)
  const j = await res.json()
  const exp = j.expiresAt ? new Date(j.expiresAt).getTime() : Date.now() + 10 * 60_000
  const entry = { token: j.token, rpcUrl: j.rpcUrl, exp }
  tokenCache.set(peerId, entry)
  return entry
}

async function fetchTimeout(url, opts, ms) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

// Pull the text out of an A2A task/message result (handles fenced JSON too).
export function extractAgentText(data) {
  const result = data?.result
  if (!result) return JSON.stringify(data)
  const parts = result.parts
  if (parts?.[0]?.text) return parts[0].text
  const artifacts = result.artifacts
  if (artifacts?.length) {
    const texts = artifacts
      .flatMap((a) => a.parts ?? [])
      .map((p) => p.text)
      .filter(Boolean)
    if (texts.length) return texts.join('\n')
  }
  const msg = result.status?.message
  if (msg?.parts?.[0]?.text) return msg.parts[0].text
  return JSON.stringify(result)
}

// Send one prompt to a Manyfold agent and return its text output. Retries
// once on transient failure (timeout / 5xx); 4xx fails fast (bad request/auth).
export async function callMfAgent(env, peerId, prompt, opts = {}) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'message/send',
    id: crypto.randomUUID(),
    params: {
      message: {
        kind: 'message', role: 'user', messageId: crypto.randomUUID(),
        parts: [{ kind: 'text', text: prompt }],
      },
    },
  })

  let lastErr
  const attempts = Math.max(1, opts.attempts ?? 2)
  const timeoutMs = opts.timeoutMs ?? 90_000
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (attempt > 0) tokenCache.delete(peerId)
      const { token, rpcUrl } = await getPeerToken(env, peerId)
      const res = await fetchTimeout(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` },
        body,
      }, timeoutMs)
      if (!res.ok) {
        const detail = `${res.status} ${await res.text()}`
        if (res.status >= 500 && attempt < attempts - 1) { lastErr = new Error(detail); continue }
        throw new Error(`agent ${peerId} failed: ${detail}`)
      }
      const data = await res.json()
      if (data.error) throw new Error(`agent ${peerId} rpc error: ${data.error.message ?? JSON.stringify(data.error)}`)
      const state = data.result?.status?.state
      if (state === 'failed') {
        const detail = extractAgentText(data)
        if (attempt < attempts - 1) { lastErr = new Error(detail); continue }
        throw new Error(`agent ${peerId} task failed: ${detail}`)
      }
      return extractAgentText(data)
    } catch (e) {
      lastErr = e
      if (attempt < attempts - 1) continue
      throw e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

// Structured-output call over A2A: since message/send is plain text in/out
// (no json_schema response format like the Anthropic API), the schema is
// appended to the prompt as an instruction and the reply is parsed the same
// tolerant way the `claude` CLI backend does (strip fences, slice outermost braces).
export async function runMfJson(env, peerId, { system, prompt, schema }, opts = {}) {
  const fullPrompt = [
    system,
    prompt,
    'Respond with ONLY a single JSON object that validates against this JSON Schema — no code fences, no commentary:',
    JSON.stringify(schema),
  ].join('\n\n')
  const text = await callMfAgent(env, peerId, fullPrompt, opts)
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '')
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('no JSON object in agent response')
  return JSON.parse(stripped.slice(start, end + 1))
}
