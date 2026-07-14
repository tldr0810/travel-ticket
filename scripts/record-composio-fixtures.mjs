// Manual helper: records a real MULTI_EXECUTE response shape (sanitized) so the
// unwrap logic in composio.mjs is verified against reality, not guesses.
// Usage: COMPOSIO_API_KEY=... node scripts/record-composio-fixtures.mjs
import fs from 'node:fs'
import { mcpSession } from '../pipeline/composio.mjs'
const s = await mcpSession()
const raw = await s.callTool('COMPOSIO_MULTI_EXECUTE_TOOL', {
  tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS', arguments: { query: 'is:read', max_results: 1, verbose: false, include_payload: false } }],
  thought: 'fixture recording', current_step: 'FIXTURE',
})
fs.mkdirSync('tests/fixtures', { recursive: true })
fs.writeFileSync('tests/fixtures/multi-execute-gmail.json', JSON.stringify(raw, null, 2))
console.log('shape keys:', Object.keys(raw ?? {}))
