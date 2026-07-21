// POST /api/trips (Task 7) — Turnstile-gated trip creation. Validates the
// guest's request, generates trip_id/todayIso HERE (a plain, non-replayed
// fetch handler — never inside the Workflow, where Date.now()/crypto would be
// non-deterministic across a replay), triggers the Workflow, and writes the
// initial 'queued' KV status so /api/trips/:id/status has something to read
// even before the Workflow's first step completes.
import { writeStatus } from '../storage.mjs'

const VISITOR_ID_RE = /^[A-Za-z0-9_-]{8,128}$/
const MAX_SENTENCE_LENGTH = 500
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
const DESIGN_PRESET_NAME_RE = /^[a-z0-9_-]{1,64}$/

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

async function verifyTurnstile(env, token, remoteip) {
  if (typeof token !== 'string' || token.length === 0) return false
  const form = new URLSearchParams()
  form.set('secret', env.TURNSTILE_SECRET_KEY ?? '')
  form.set('response', token)
  if (remoteip) form.set('remoteip', remoteip)
  const res = await fetch(TURNSTILE_VERIFY_URL, { method: 'POST', body: form })
  const result = await res.json()
  return result?.success === true
}

// design is optional (spec §3: custom_theme only runs "訪客選了才跑") — when
// present it must already match TripWorkflowParams's union shape; the CLI's
// parseDesignChoice (flag-string parsing) is not reused here since the API
// body carries a structured object, not a --design= flag string.
function validateDesign(design) {
  if (design === undefined) return { ok: true, design: undefined }
  if (design?.kind === 'preset' && typeof design.name === 'string' && DESIGN_PRESET_NAME_RE.test(design.name)) {
    return { ok: true, design: { kind: 'preset', name: design.name } }
  }
  if (design?.kind === 'custom' && typeof design.style === 'string' && design.style.trim().length > 0 && design.style.length <= 200) {
    return { ok: true, design: { kind: 'custom', style: design.style.trim() } }
  }
  return { ok: false }
}

function makeTripId(todayIso) {
  const compact = todayIso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const random = crypto.randomUUID().replace(/-/g, '').slice(0, 8)
  return `trip_${compact}_${random}`
}

export async function handleCreateTrip(request, env) {
  let body
  try {
    body = await request.json()
  } catch {
    return jsonResponse({ error: 'invalid JSON body' }, 400)
  }

  const { sentence, visitor_id: visitorId, turnstile_token: turnstileToken, design } = body ?? {}

  const remoteip = request.headers.get('cf-connecting-ip') ?? undefined
  const verified = await verifyTurnstile(env, turnstileToken, remoteip)
  if (!verified) {
    return jsonResponse({ error: 'Turnstile verification failed — please retry the challenge.' }, 403)
  }

  if (typeof sentence !== 'string' || sentence.trim().length === 0 || sentence.length > MAX_SENTENCE_LENGTH) {
    return jsonResponse({ error: `sentence must be a non-empty string up to ${MAX_SENTENCE_LENGTH} characters` }, 400)
  }
  if (typeof visitorId !== 'string' || !VISITOR_ID_RE.test(visitorId)) {
    return jsonResponse({ error: 'visitor_id must be an 8-128 character identifier containing only letters, numbers, _ or -' }, 400)
  }
  const designResult = validateDesign(design)
  if (!designResult.ok) {
    return jsonResponse({ error: 'design must be omitted or {kind:"preset",name} / {kind:"custom",style}' }, 400)
  }

  const todayIso = new Date().toISOString()
  const tripId = makeTripId(todayIso)

  await env.TRIP_WORKFLOW.create({
    id: tripId,
    params: { tripId, sentence, todayIso, visitorId, design: designResult.design },
  })
  await writeStatus(env, tripId, { phase: 'queued', trip_id: tripId })

  return jsonResponse({ trip_id: tripId }, 201)
}
