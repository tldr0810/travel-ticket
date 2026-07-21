// Worker entry point (Task 9): path-based dispatch only — every route's real
// logic already lives in worker/routes/*.mjs (Tasks 7-8) and worker/storage.mjs
// (Task 5). Three buckets, checked in order:
//   /api/*         -> the JSON API route handlers
//   /trips/<id>/*  -> per-trip rendered site files, out of TRIPS_SITES (KV)
//   everything else -> the static app-shell (home/connect/progress pages,
//                      Task 10), served via the Worker's [assets] binding
//
// Plain .mjs (not .ts) so it's directly node:test-able like every other
// portable module here — it needs no cloudflare:workers imports of its own.
// worker/entry.ts is the actual wrangler `main`: a thin, untested-by-design
// wrapper (matches pipeline-workflow.ts's own precedent) that re-exports this
// module's default fetch handler alongside TripPipelineWorkflow, since
// Cloudflare Workflows bindings resolve their class_name against the main
// script's exports — importing pipeline-workflow.ts's real .ts syntax here
// would break `node --test`, which can't parse it directly.
import { handleCreateTrip } from './routes/create-trip.mjs'
import { handleTripStatus } from './routes/status.mjs'
import { handleConnectLink, handleConnectStatus } from './routes/connect.mjs'
import { handleConfig } from './routes/config.mjs'
import { getTripFile } from './storage.mjs'

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

// segments is the path with the leading 'api' already stripped, e.g.
// ['trips'], ['trips', ':id', 'status'], ['trips', ':id', 'connect', ':provider', 'link'].
async function routeApi(request, env, segments) {
  if (segments.length === 1 && segments[0] === 'config') {
    if (request.method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405)
    return handleConfig(request, env)
  }
  if (segments[0] !== 'trips') return jsonResponse({ error: 'not found' }, 404)

  if (segments.length === 1) {
    if (request.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405)
    return handleCreateTrip(request, env)
  }

  const tripId = segments[1]
  if (segments.length === 3 && segments[2] === 'status') {
    if (request.method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405)
    return handleTripStatus(request, env, tripId)
  }
  if (segments.length === 5 && segments[2] === 'connect' && segments[4] === 'link') {
    if (request.method !== 'POST') return jsonResponse({ error: 'method not allowed' }, 405)
    return handleConnectLink(request, env, tripId, segments[3])
  }
  if (segments.length === 5 && segments[2] === 'connect' && segments[4] === 'status') {
    if (request.method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405)
    return handleConnectStatus(request, env, tripId, segments[3])
  }
  return jsonResponse({ error: 'not found' }, 404)
}

// /trips/<id> and /trips/<id>/ both mean the trip's index page; anything past
// that is a literal file path already produced by render.mjs's buildItineraryFiles.
async function routeTripSite(env, segments) {
  const [tripId, ...rest] = segments
  const path = rest.length === 0 ? 'index.html' : rest.join('/')
  const file = await getTripFile(env, tripId, path)
  if (!file) return jsonResponse({ error: 'not found' }, 404)
  return file
}

export async function handleFetch(request, env) {
  const url = new URL(request.url)
  const segments = url.pathname.split('/').filter(Boolean)

  if (segments[0] === 'api') return routeApi(request, env, segments.slice(1))
  if (segments[0] === 'trips' && segments.length > 1) return routeTripSite(env, segments.slice(1))

  return env.ASSETS.fetch(request)
}

export default { fetch: handleFetch }
