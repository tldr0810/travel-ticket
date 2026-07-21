// Agent implementations for the itinerary pipeline.
// Each LLM agent is a single structured-output call; the timezone agent is
// pure code; the Gmail/Calendar context agents are stubs until a connector is
// wired in (see README).
//
// Portable core: zero Node builtins, safe to bundle into a Cloudflare Worker
// (guarded by tests/agents-core-portable.test.mjs). Two LLM backends live here:
//   sdk — Anthropic API via @anthropic-ai/sdk (needs ANTHROPIC_API_KEY or an
//         `ant auth login` profile). Uses real structured outputs.
//   mf  — calls a Manyfold platform agent over the A2A protocol (mf-client.mjs).
//         Fetch-based, Workers-compatible: this is the backend the deployed
//         Cloudflare Worker uses, so the public site never holds a raw
//         Anthropic key — LLM calls run against the user's own Manyfold agent
//         and are billed to their Manyfold account.
//
// The third backend — cli (headless `claude -p`, Claude Code login /
// subscription, no API key) — spawns a subprocess and is Node-only, so it
// (plus poster generation, also fs/exec-based) lives in `agents-local.mjs`
// instead. See `createLocalContext` there for backend selection that
// includes cli.
import Anthropic from '@anthropic-ai/sdk'
import { mcpSession, composioEnabled } from './composio.mjs'
import { localToUtc, runTimezoneAgent, tzOffsetMinutes } from './timezone.mjs'
import { runMfJson } from './mf-client.mjs'

export { localToUtc, runTimezoneAgent, tzOffsetMinutes }

export const MODEL = 'claude-opus-4-8'

export async function createContext(preferred) {
  const hasApiCreds = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
  const backend = preferred ?? (hasApiCreds ? 'sdk' : null)
  if (backend === 'sdk') return { backend, client: new Anthropic() }
  throw new Error('No LLM backend available: set ANTHROPIC_API_KEY (or `ant auth login`). For the `claude` CLI backend, use createLocalContext from agents-local.mjs.')
}

// Worker-side context: env carries MF_API_URL/MF_API_TOKEN/MF_AGENT_ID plus
// the AGENT_PIPELINE peer id (one shared Manyfold agent handles every stage,
// distinguished by prompt only — see mf-client.mjs). Constructed explicitly
// from Worker bindings, not auto-detected from process.env like createContext.
export function createMfContext(env) {
  if (!env?.MF_API_URL || !env?.MF_API_TOKEN || !env?.AGENT_PIPELINE) {
    throw new Error('Manyfold backend needs MF_API_URL, MF_API_TOKEN and AGENT_PIPELINE')
  }
  return { backend: 'mf', env }
}

// Backend-agnostic structured-output call (sdk or mf), shared by connector
// agents and (as runStructuredJson) by the trip pipeline for theme work.
// The cli-aware equivalent lives in agents-local.mjs.
async function runJson(ctx, { system, prompt, schema, maxTokens = 4000 }) {
  if (!ctx) throw new Error('no LLM context')
  if (ctx.backend === 'mf') return runMfJson(ctx.env, ctx.env.AGENT_PIPELINE, { system, prompt, schema })
  const response = await ctx.client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    output_config: { format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: prompt }],
  })
  return parseStructured(response)
}

export { runJson as runStructuredJson }

// ---------------------------------------------------------------------------
// Structured-output schemas

export const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    destination: { type: 'string', description: 'Human-readable destination, e.g. "Switzerland: Lucerne, Interlaken"' },
    destination_timezone: { type: 'string', description: 'IANA timezone of the destination' },
    home_city: { type: 'string' },
    home_timezone: { type: 'string', description: 'IANA timezone the traveller starts from. Default Asia/Taipei if unclear.' },
    start_date: { type: 'string', description: 'YYYY-MM-DD. If the request has no dates, pick a sensible future window and record the assumption in notes.' },
    end_date: { type: 'string', description: 'YYYY-MM-DD inclusive' },
    travellers: { type: 'integer' },
    pace: { type: 'string', enum: ['relaxed', 'balanced', 'full'] },
    no_car: { type: 'boolean' },
    bases: {
      type: 'array',
      description: 'Ordered overnight bases with nights per base; must cover the whole trip',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, nights: { type: 'integer' } },
        required: ['name', 'nights'],
        additionalProperties: false,
      },
    },
    interests: { type: 'array', items: { type: 'string' } },
    language: { type: 'string', description: 'Language the request was written in, e.g. zh-Hant' },
    notes: { type: 'string', description: 'Assumptions made while interpreting the request' },
  },
  required: ['destination', 'destination_timezone', 'home_city', 'home_timezone', 'start_date', 'end_date', 'travellers', 'pace', 'no_car', 'bases', 'interests', 'language', 'notes'],
  additionalProperties: false,
}

export const DISCOVERY_SCHEMA = {
  type: 'object',
  properties: {
    pois: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          base: { type: 'string', description: 'Which overnight base this is closest to' },
          kind: { type: 'string', enum: ['sight', 'meal', 'rest'] },
          duration_minutes: { type: 'integer' },
          best_time: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'any'] },
          notes: { type: 'string' },
          source_label: { type: 'string', description: 'Label of a source in sources[] backing this, or empty' },
        },
        required: ['title', 'base', 'kind', 'duration_minutes', 'best_time', 'notes', 'source_label'],
        additionalProperties: false,
      },
    },
    transports: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          mode: { type: 'string' },
          minutes: { type: 'integer' },
          notes: { type: 'string' },
          source_label: { type: 'string' },
        },
        required: ['from', 'to', 'mode', 'minutes', 'notes', 'source_label'],
        additionalProperties: false,
      },
    },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, url: { type: 'string' } },
        required: ['label', 'url'],
        additionalProperties: false,
      },
    },
  },
  required: ['pois', 'transports', 'sources'],
  additionalProperties: false,
}

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    variant: { type: 'string', enum: ['both', 'relaxed', 'full'] },
    type: { type: 'string', enum: ['travel', 'sight', 'meal', 'rest'] },
    title: { type: 'string' },
    start_local: { type: 'string', description: 'HH:MM destination local time' },
    end_local: { type: 'string', description: 'HH:MM destination local time' },
    location: { type: 'string' },
    transport_minutes: { type: 'integer' },
    notes: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
  },
  required: ['variant', 'type', 'title', 'start_local', 'end_local', 'location', 'transport_minutes', 'notes', 'sources'],
  additionalProperties: false,
}

export const COMPOSER_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    days: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string' },
          title: { type: 'string', description: 'Short day title; use "A → B" for transfer days' },
          base: { type: 'string' },
          handwritten_note: { type: 'string', description: 'Optional. One colloquial reminder (≤22 chars, request language) a travel companion would pencil on the ticket stub. Must paraphrase an existing warning/note for this day — never introduce new facts. Omit when nothing is worth writing.' },
          items: { type: 'array', items: ITEM_SCHEMA },
        },
        required: ['date', 'title', 'base', 'items'],
        additionalProperties: false,
      },
    },
    alternatives: {
      type: 'object',
      properties: {
        relaxed: { type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'], additionalProperties: false },
        full: { type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'], additionalProperties: false },
      },
      required: ['relaxed', 'full'],
      additionalProperties: false,
    },
    actions_suggested: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          requires_approval: { type: 'boolean' },
        },
        required: ['type', 'title', 'description', 'requires_approval'],
        additionalProperties: false,
      },
    },
    cover: {
      type: 'object',
      description: 'Cover-page copy for the ticket-style site',
      properties: {
        title_top: { type: 'string', description: 'Big headline line 1, e.g. destination name' },
        title_accent: { type: 'string', description: 'Big headline line 2, e.g. "by Rail"' },
        eyebrow: { type: 'string' },
        handwritten_note: { type: 'string', description: 'Optional. One trip-level colloquial reminder (≤22 chars) pencilled on the cover stub; paraphrase the most human warning, no new facts.' },
      },
      required: ['title_top', 'title_accent', 'eyebrow'],
      additionalProperties: false,
    },
  },
  required: ['summary', 'warnings', 'days', 'alternatives', 'actions_suggested', 'cover'],
  additionalProperties: false,
}

const parseStructured = (response) => {
  if (response.stop_reason === 'refusal') {
    throw new Error('model refused the request')
  }
  const text = response.content.find((b) => b.type === 'text')?.text
  if (!text) throw new Error(`no text block in response (stop_reason=${response.stop_reason})`)
  return JSON.parse(text)
}

// ---------------------------------------------------------------------------
// Agents

export const BRIEF_SYSTEM = 'You are the Trip Brief Agent in a travel-planning pipeline. Turn a one-sentence trip request into a structured brief. Interpret conservatively; record every assumption (dates, pace, traveller count) in notes. Dates must be in the future relative to today.'

export async function runTripBriefAgent(ctx, sentence, todayIso) {
  const prompt = `Today is ${todayIso}. Trip request: ${sentence}`
  if (ctx.backend === 'mf') {
    return runMfJson(ctx.env, ctx.env.AGENT_PIPELINE, { system: BRIEF_SYSTEM, prompt, schema: BRIEF_SCHEMA })
  }
  const response = await ctx.client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: BRIEF_SCHEMA } },
    system: BRIEF_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  })
  return parseStructured(response)
}

export const DISCOVERY_SYSTEM = 'You are the Local Discovery Agent in a travel-planning pipeline. Research the destination with web search: key sights, food areas, and transport legs between bases. Prefer official sources (tourism boards, railway operators, attraction sites). Every transport leg and weather/season-dependent sight should cite a source. Keep the list practical: roughly 3-5 POIs per base, not an encyclopedia.'

export async function runLocalDiscoveryAgent(ctx, brief) {
  const prompt = `Trip brief:\n${JSON.stringify(brief, null, 2)}`
  if (ctx.backend === 'mf') {
    // The Manyfold peer agent is a full agent runtime (its own web-search
    // tooling, not a per-call flag) — the system prompt already asks for it.
    return runMfJson(ctx.env, ctx.env.AGENT_PIPELINE, { system: DISCOVERY_SYSTEM, prompt, schema: DISCOVERY_SCHEMA }, { timeoutMs: 150_000 })
  }
  const stream = ctx.client.messages.stream({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: DISCOVERY_SCHEMA } },
    tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }],
    system: DISCOVERY_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  })
  const response = await stream.finalMessage()
  return parseStructured(response)
}

// Gmail / Calendar context agents. Both are wired to real connectors
// (Composio MCP). Both report their own status honestly so the final
// artifact never pretends bookings/events were checked when they weren't.
const BOOKINGS_SCHEMA = {
  type: 'object',
  properties: {
    bookings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['flight', 'hotel', 'train', 'car', 'activity'] },
          vendor: { type: 'string' },
          confirmation_no: { type: 'string' },
          start: { type: 'string' },
          end: { type: 'string' },
          location: { type: 'string' },
          pax: { type: 'integer' },
        },
        required: ['type', 'vendor'],
      },
    },
  },
  required: ['bookings'],
}

const EXTRACT_SYSTEM = 'You extract travel bookings from emails. Only extract fields literally present in the text; leave missing fields as empty string / omit. NEVER invent vendors, confirmation numbers or dates. If no real bookings, return {"bookings":[]}.'

export async function runTravelContextAgent(ctx, brief, deps = {}) {
  if (!composioEnabled()) {
    return { status: 'skipped', confidence: 0, notes: 'COMPOSIO_API_KEY not set; booking emails were not checked.', bookings: [] }
  }
  try {
    const session = await (deps.session ? deps.session() : mcpSession())
    const destWord = String(brief?.destination || '').split(/[:,&，、]/)[0].trim()
    const query = `(booking OR reservation OR confirmation OR itinerary OR e-ticket OR 訂位 OR 訂房 OR 確認) ${destWord} newer_than:180d`
    const list = await session.execToolkitTool('GMAIL_FETCH_EMAILS', {
      query, max_results: 20, verbose: false, include_payload: false,
    })
    const messages = (list?.messages ?? []).filter((m) => m?.messageId)
    if (!messages.length) return { status: 'ok', confidence: 0.6, notes: 'No booking-looking emails found in the last 180 days.', bookings: [] }

    const shortlist = messages.slice(0, 10)
    const bodies = []
    for (const m of shortlist) {
      try {
        const full = await session.execToolkitTool('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', { message_id: m.messageId, format: 'full' })
        const text = full?.messageText ?? full?.snippet ?? JSON.stringify(full).slice(0, 2000)
        bodies.push(`--- EMAIL (subject: ${full?.subject ?? m.subject ?? ''}) ---\n${String(text).slice(0, 4000)}`)
      } catch { /* one bad mail never kills the agent */ }
    }
    if (!bodies.length) return { status: 'ok', confidence: 0.5, notes: 'Emails found but none could be fetched in full.', bookings: [] }

    const llm = deps.llm ?? ((req) => runJson(ctx, req))
    const req = { system: EXTRACT_SYSTEM, prompt: `Trip: ${brief.destination}, ${brief.start_date}→${brief.end_date}.\n\n${bodies.join('\n\n')}`, schema: BOOKINGS_SCHEMA }
    let extracted
    try { extracted = await llm(req) } catch { try { extracted = await llm(req) } catch { extracted = null } }
    const bookings = Array.isArray(extracted?.bookings) ? extracted.bookings : []
    return { status: 'ok', confidence: bookings.length ? 0.75 : 0.6, notes: `Checked ${bodies.length} emails; extracted ${bookings.length} booking(s).`, bookings }
  } catch (error) {
    return { status: 'skipped', confidence: 0, notes: `Gmail check skipped: ${error.message}`, bookings: [] }
  }
}

export async function runCalendarAgent(ctx, brief, deps = {}) {
  if (!composioEnabled()) {
    return { status: 'skipped', confidence: 0, notes: 'COMPOSIO_API_KEY not set; fixed events were not checked.', events: [] }
  }
  try {
    const session = await (deps.session ? deps.session() : mcpSession())
    const data = await session.execToolkitTool('GOOGLECALENDAR_EVENTS_LIST', {
      calendarId: 'primary',
      timeMin: `${brief.start_date}T00:00:00Z`,
      timeMax: `${brief.end_date}T23:59:59Z`,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 50,
    })
    const items = data?.items ?? data?.events ?? []
    const events = items.map((e) => ({
      title: e.summary ?? '(untitled)',
      start: e.start?.dateTime ?? e.start?.date ?? '',
      end: e.end?.dateTime ?? e.end?.date ?? '',
      all_day: Boolean(e.start?.date && !e.start?.dateTime),
    }))
    return { status: 'ok', confidence: 0.9, notes: `Found ${events.length} calendar event(s) inside the trip window.`, events }
  } catch (error) {
    return { status: 'skipped', confidence: 0, notes: `Calendar check skipped: ${error.message}`, events: [] }
  }
}

const NOTES_SCHEMA = {
  type: 'object',
  properties: {
    travel_notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          note: { type: 'string' },
          location: { type: 'string' },
          url: { type: 'string' },
          category: { type: 'string' },
        },
        required: ['title'],
      },
    },
  },
  required: ['travel_notes'],
}

export async function runNotionAgent(ctx, brief, deps = {}) {
  if (!composioEnabled()) {
    return { status: 'skipped', confidence: 0, notes: 'COMPOSIO_API_KEY not set; Notion notes were not checked.', travel_notes: [] }
  }
  try {
    const session = await (deps.session ? deps.session() : mcpSession())
    const destWord = String(brief?.destination || '').split(/[:,&，、]/)[0].trim()
    const found = await session.execToolkitTool('NOTION_SEARCH_NOTION_PAGE', { query: destWord, page_size: 5, filter_value: 'page' })
    const pages = (found?.results ?? []).filter((p) => p?.id)
    if (!pages.length) return { status: 'ok', confidence: 0.6, notes: 'No Notion pages matched the destination.', travel_notes: [] }
    const mds = []
    for (const p of pages.slice(0, 3)) {
      try {
        const md = await session.execToolkitTool('NOTION_GET_PAGE_MARKDOWN', { page_id: p.id })
        mds.push(`--- PAGE: ${p.title ?? p.id} ---\n${String(md?.markdown ?? '').slice(0, 6000)}`)
      } catch { /* one bad page never kills the agent */ }
    }
    if (!mds.length) return { status: 'ok', confidence: 0.5, notes: 'Notion pages found but none readable.', travel_notes: [] }
    const llm = deps.llm ?? ((req) => runJson(ctx, req))
    const req = {
      system: 'You extract travel-relevant notes (POIs, restaurants, bookings, checklists) from the user\'s own Notion pages. Only extract what is literally present; never invent. Empty array if nothing relevant.',
      prompt: `Trip: ${brief.destination}, ${brief.start_date}→${brief.end_date}.\n\n${mds.join('\n\n')}`,
      schema: NOTES_SCHEMA,
    }
    let extracted
    try { extracted = await llm(req) } catch { try { extracted = await llm(req) } catch { extracted = null } }
    const travel_notes = Array.isArray(extracted?.travel_notes) ? extracted.travel_notes : []
    return { status: 'ok', confidence: travel_notes.length ? 0.7 : 0.6, notes: `Read ${mds.length} Notion page(s); extracted ${travel_notes.length} note(s).`, travel_notes }
  } catch (error) {
    return { status: 'skipped', confidence: 0, notes: `Notion check skipped: ${error.message}`, travel_notes: [] }
  }
}

export const COMPOSER_SYSTEM = [
  'You are the Itinerary Composer Agent in a travel-planning pipeline. Compose a realistic day-by-day itinerary from the agent inputs.',
  'Rules:',
  '- One day object per date from start_date to end_date inclusive; arrival/departure days stay light.',
  '- Day titles must be short (max ~12 characters): the headline theme only, e.g. "嵐山竹林・天龍寺" or "A → B". Put variant details in item notes, never in the day title.',
  '- Times are destination-local HH:MM, chronological, non-overlapping within a variant, roughly 09:00-21:00.',
  '- Provide both a relaxed and a full variant: shared items use variant "both"; upgrades use "full"; low-key alternatives use "relaxed". Include daily meals and at least one rest block on full sightseeing days.',
  '- Use transport legs and POIs from discovery where available; reference discovery source labels in item sources.',
  '- Mark uncertain schedules as planning placeholders in notes and add matching warnings.',
  '- Write summary, notes, warnings and actions in the language of the original request; keep place names in their common form.',
  '- actions_suggested: booking checks, calendar write, checklist draft — all requires_approval true.',
  '- handwritten_note (cover + per-day, optional): one short colloquial line (≤22 chars) a companion would pencil on the stub, e.g. paraphrasing the season/booking warning. Strictly a paraphrase of warnings/notes already present — no new facts; omit rather than invent.',
].join('\n')

export async function runComposerAgent(ctx, { sentence, brief, timezone, discovery, context, calendar }) {
  const prompt = [
    `Original request: ${sentence}`,
    `Trip brief:\n${JSON.stringify(brief, null, 2)}`,
    `Timezone analysis:\n${JSON.stringify(timezone, null, 2)}`,
    `Local discovery:\n${JSON.stringify(discovery, null, 2)}`,
    `Travel context (bookings): ${JSON.stringify(context)}`,
    `Calendar (fixed events): ${JSON.stringify(calendar)}`,
  ].join('\n\n')
  if (ctx.backend === 'mf') {
    return runMfJson(ctx.env, ctx.env.AGENT_PIPELINE, { system: COMPOSER_SYSTEM, prompt, schema: COMPOSER_SCHEMA }, { timeoutMs: 150_000 })
  }
  const stream = ctx.client.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: COMPOSER_SCHEMA } },
    system: COMPOSER_SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  })
  const response = await stream.finalMessage()
  return parseStructured(response)
}

// ---------------------------------------------------------------------------
// Poster Agent — 記念票畫版生圖

// 記念票海報 prompt — Zack 的 typographic travel poster prompt 參數化版：
// 城市名、真實地標（Local Discovery 查證過的）、palette（跟 theme 同色系）動態代入。
export function posterPrompt({ city, landmarks = [], palette, slogan = '' }) {
  const landmarkLine = landmarks.length
    ? `Feature these real landmarks and cultural elements of ${city} — accuracy matters, do not invent or substitute others: ${landmarks.join(', ')}.`
    : `Ensure every landmark, architectural style, sign, and cultural element is accurate for ${city} — not universal or incorrect landmarks.`
  return [
    'Create a clean, modern, typographic travel poster in which the name of the city itself becomes a composition.',
    `Highlight the city name ${city.toUpperCase()} in large, bold capital letters without serifs across the entire width of the illustration.`,
    "Integrate the city's most iconic landmarks, architecture, streets, transportation, cultural symbols, and local details into, around, and inside the letters. Let the landmarks interact naturally with the typography while maintaining legibility.",
    'Use an elegant flat vector illustration with clear geometric shapes, minimal details, clear contours, barely noticeable shadows, and excellent editorial aesthetics.',
    `Use a limited color palette built from exactly these tones so the poster feels timeless: deep night ${palette.night}, warm cream ${palette.paper}, vermilion red ${palette.rail}, muted green ${palette.green}.`,
    landmarkLine,
    slogan ? `Include a small elegant slogan under the city name in minimal print-shop type: "${slogan}".` : '',
    'Add small decorative elements only if specific to the city (street lights, trees, birds, trams, ferries).',
    'Maintain voluminous negative space with a clean background and a perfectly balanced composition.',
    'Landscape 3:2 aspect ratio, museum-quality flat vector, centered composition.',
  ].filter(Boolean).join(' ')
}

// runPosterAgent (codex CLI / Gemini API / manual backends, all fs-writing)
// lives in agents-local.mjs — poster generation is local-only, not part of
// the deployed Worker's pipeline (spec §3 has no poster step).
