// Connect-accounts endpoints (Task 8) — thin wrappers around composio.mjs's
// existing createConnectorLink/connectorStatus, which already implement the
// per-visitor isolation and configuration_required/authorization_required
// states (spec §2 step 2, §6 "訪客隔離沿用 per-visitor_id 設計"). tripId is
// accepted (matches the plan's routing signature — Task 9's router parses it
// out of the URL path) but the Composio call itself keys only on visitor_id,
// never on tripId: one visitor's connected accounts are the same across every
// trip they start, matching composio.mjs's own account model.
//
// visitor_id travels as a query param, same value the frontend generated and
// stored in localStorage for POST /api/trips (spec §2 step 1) — there is no
// server-side session to recover it from otherwise.
import { createConnectorLink, connectorStatus, connectorNames } from '../../pipeline/composio.mjs'

const VISITOR_ID_RE = /^[A-Za-z0-9_-]{8,128}$/
const AUTH_CONFIG_ENV_KEY = {
  gmail: 'COMPOSIO_GMAIL_AUTH_CONFIG_ID',
  calendar: 'COMPOSIO_CALENDAR_AUTH_CONFIG_ID',
  notion: 'COMPOSIO_NOTION_AUTH_CONFIG_ID',
}

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

function readVisitorId(request) {
  return new URL(request.url).searchParams.get('visitor_id')
}

function validationError(visitorId, provider) {
  if (typeof visitorId !== 'string' || !VISITOR_ID_RE.test(visitorId)) {
    return 'visitor_id must be an 8-128 character identifier containing only letters, numbers, _ or -'
  }
  if (!connectorNames().includes(provider)) {
    return `unknown connector: ${provider}`
  }
  return null
}

export async function handleConnectLink(request, env, tripId, provider, deps = {}) {
  const visitorId = readVisitorId(request)
  const error = validationError(visitorId, provider)
  if (error) return jsonResponse({ error }, 400)

  const result = await createConnectorLink({
    visitorId, connector: provider, apiKey: env.COMPOSIO_API_KEY, authConfigId: env[AUTH_CONFIG_ENV_KEY[provider]], client: deps.client,
  })
  return jsonResponse(result, 200)
}

export async function handleConnectStatus(request, env, tripId, provider, deps = {}) {
  const visitorId = readVisitorId(request)
  const error = validationError(visitorId, provider)
  if (error) return jsonResponse({ error }, 400)

  const result = await connectorStatus({ visitorId, connector: provider, apiKey: env.COMPOSIO_API_KEY, client: deps.client })
  return jsonResponse({ connected: result.status === 'connected', status: result.status }, 200)
}
