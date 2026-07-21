export interface Env {
  ASSETS: Fetcher
  TRIPS_KV: KVNamespace
  TRIPS_SITES: KVNamespace
  TRIP_WORKFLOW: Workflow

  // Manyfold Agent API (Option B) — see pipeline/agents.mjs's createMfContext.
  MF_API_URL: string
  MF_AGENT_ID: string
  AGENT_PIPELINE: string
  MF_API_TOKEN: string // secret, set via `wrangler secret put`

  // Composio connectors — absent until Zack provisions them (see HANDOVER-CLOUD.md).
  COMPOSIO_API_KEY?: string
  COMPOSIO_GMAIL_AUTH_CONFIG_ID?: string
  COMPOSIO_CALENDAR_AUTH_CONFIG_ID?: string
  COMPOSIO_NOTION_AUTH_CONFIG_ID?: string

  // Turnstile — absent until Zack provisions it. SITE_KEY is public/client-side
  // (served via GET /api/config to worker/public/index.html); SECRET_KEY is
  // server-side-only, checked by worker/routes/create-trip.mjs.
  TURNSTILE_SITE_KEY?: string
  TURNSTILE_SECRET_KEY?: string
}

export interface TripWorkflowParams {
  tripId: string
  sentence: string
  todayIso: string
  visitorId: string
  design?: { kind: 'preset'; name: string } | { kind: 'custom'; style: string }
}
