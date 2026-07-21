// GET /api/config (Task 10) — the Turnstile site key is a public, client-side
// value (unlike TURNSTILE_SECRET_KEY), but it's still Zack-provisioned and
// must not be hardcoded into worker/public/index.html — this lets the home
// page pick it up at runtime from whatever env the Worker is deployed with.
function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })
}

export async function handleConfig(request, env) {
  return jsonResponse({ turnstile_site_key: env.TURNSTILE_SITE_KEY ?? null }, 200)
}
