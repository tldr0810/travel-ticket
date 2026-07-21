// KV-only storage adapter for the deployed Worker (see the 2026-07-21 update
// to docs/superpowers/plans/2026-07-21-public-cloud-deploy.md — R2 needs a
// credit card on the Cloudflare account, so both rendered site files and
// per-trip progress live in KV namespaces instead).
//
// env.TRIPS_SITES (KVNamespace) — rendered site files, key `trips/<id>/<path>`.
// env.TRIPS_KV (KVNamespace)    — progress status, key `trip:<id>:status`.

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function contentTypeFor(path) {
  const ext = path.slice(path.lastIndexOf('.'))
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

function siteKey(tripId, path) {
  return `trips/${tripId}/${path}`
}

export async function saveTripFiles(env, tripId, fileMap) {
  await Promise.all([...fileMap].map(([path, body]) => env.TRIPS_SITES.put(siteKey(tripId, path), body)))
}

export async function saveTripJson(env, tripId, itinerary) {
  await env.TRIPS_SITES.put(siteKey(tripId, 'itinerary.json'), JSON.stringify(itinerary))
}

export async function getTripFile(env, tripId, path) {
  const body = await env.TRIPS_SITES.get(siteKey(tripId, path), 'arrayBuffer')
  if (body === null) return null
  return new Response(body, { headers: { 'content-type': contentTypeFor(path) } })
}

export async function writeStatus(env, tripId, status) {
  await env.TRIPS_KV.put(`trip:${tripId}:status`, JSON.stringify(status))
}

export async function readStatus(env, tripId) {
  const status = await env.TRIPS_KV.get(`trip:${tripId}:status`, 'json')
  return status ?? null
}
