// Live smoke: real Composio + real LLM. Not part of `npm test` (needs real keys).
// Usage: COMPOSIO_API_KEY=... node scripts/composio-smoke.mjs
import { createContext, runTravelContextAgent, runCalendarAgent, runNotionAgent } from '../pipeline/agents.mjs'
const brief = { destination: 'Switzerland: Lucerne', start_date: '2026-07-20', end_date: '2026-07-25' }
const ctx = await createContext().catch(() => null)
for (const [name, fn] of [['gmail', runTravelContextAgent], ['calendar', runCalendarAgent], ['notion', runNotionAgent]]) {
  const t0 = Date.now()
  const r = await fn(ctx, brief)
  const count = (r.bookings ?? r.events ?? r.travel_notes ?? []).length
  console.log(`${name}: status=${r.status} items=${count} (${((Date.now() - t0) / 1000).toFixed(1)}s) — ${r.notes}`)
}
