// GET /api/trips/:id/status (Task 8) — thin KV read. Mirrors server.mjs's
// existing {phase, agents, log, manifest, error} status shape (worker/
// pipeline-workflow.ts already writes exactly this shape via
// pipeline-steps.mjs's summarizeAgentStatuses), so the progress page's
// polling logic ports with minimal changes.
import { readStatus } from '../storage.mjs'

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

export async function handleTripStatus(request, env, tripId) {
  const status = await readStatus(env, tripId)
  if (!status) return jsonResponse({ error: 'unknown trip_id' }, 404)
  return jsonResponse(status, 200)
}
