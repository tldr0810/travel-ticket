// Agent implementations for the itinerary pipeline.
// Each LLM agent is a single structured-output call; the timezone agent is
// pure code; the Gmail/Calendar context agents are stubs until a connector is
// wired in (see README).
//
// Two LLM backends:
//   sdk — Anthropic API via @anthropic-ai/sdk (needs ANTHROPIC_API_KEY or an
//         `ant auth login` profile). Uses real structured outputs.
//   cli — headless `claude -p` (Claude Code login / subscription, no API key).
//         JSON is requested by prompt and validated by parsing.
import Anthropic from '@anthropic-ai/sdk'
import { execFile, execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { mergedTokens } from './themes.mjs'
import { mcpSession, composioEnabled } from './composio.mjs'

const execFileAsync = promisify(execFile)

const spawnWithStdin = (cmd, args, input) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d })
  child.stderr.on('data', (d) => { stderr += d })
  child.on('error', reject)
  child.on('close', (code) => {
    if (code === 0) resolve({ stdout, stderr })
    else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 500) || stdout.slice(0, 500)}`))
  })
  child.stdin.end(input)
})

export const MODEL = 'claude-opus-4-8'

const hasCommand = async (cmd) => {
  try {
    await execFileAsync('which', [cmd])
    return true
  } catch {
    return false
  }
}

export async function createContext(preferred) {
  const hasApiCreds = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
  const backend = preferred
    ?? (hasApiCreds ? 'sdk' : (await hasCommand('claude')) ? 'cli' : null)
  if (backend === 'sdk') return { backend, client: new Anthropic() }
  if (backend === 'cli') return { backend, client: null }
  throw new Error('No LLM backend available: set ANTHROPIC_API_KEY (or `ant auth login`), or install the `claude` CLI and log in.')
}

// --- claude CLI backend -----------------------------------------------------

const extractJson = (text) => {
  const stripped = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '')
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('no JSON object in CLI response')
  return JSON.parse(stripped.slice(start, end + 1))
}

async function runCliJson({ system, prompt, schema, webSearch = false }) {
  const args = ['-p', '--output-format', 'json', '--append-system-prompt', system]
  if (process.env.PIPELINE_CLAUDE_MODEL) args.push('--model', process.env.PIPELINE_CLAUDE_MODEL)
  if (webSearch) args.push('--allowedTools', 'WebSearch,WebFetch')
  const fullPrompt = [
    prompt,
    'Respond with ONLY a single JSON object that validates against this JSON Schema — no code fences, no commentary:',
    JSON.stringify(schema),
  ].join('\n\n')
  const { stdout } = await spawnWithStdin('claude', args, fullPrompt)
  const envelope = JSON.parse(stdout)
  if (envelope.is_error) throw new Error(`claude CLI error: ${String(envelope.result).slice(0, 300)}`)
  return extractJson(envelope.result)
}

// Backend-agnostic structured-output call (sdk or cli), shared by connector agents.
async function runJson(ctx, { system, prompt, schema, maxTokens = 4000 }) {
  if (!ctx) throw new Error('no LLM context')
  if (ctx.backend === 'cli') return runCliJson({ system, prompt, schema })
  const response = await ctx.client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    output_config: { format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: prompt }],
  })
  return parseStructured(response)
}

// ---------------------------------------------------------------------------
// Timezone helpers (also used by the orchestrator for local-time → UTC)

export const tzOffsetMinutes = (timeZone, atIso) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(atIso))
  const raw = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00'
  const match = raw.match(/GMT([+-])(\d{2}):(\d{2})/)
  if (!match) return 0
  const sign = match[1] === '-' ? -1 : 1
  return sign * (Number(match[2]) * 60 + Number(match[3]))
}

// Convert a wall-clock time in `timeZone` on `date` to a UTC ISO string.
export const localToUtc = (date, time, timeZone) => {
  let guess = Date.parse(`${date}T${time}:00Z`)
  for (let i = 0; i < 2; i++) {
    guess = Date.parse(`${date}T${time}:00Z`) - tzOffsetMinutes(timeZone, new Date(guess).toISOString()) * 60_000
  }
  return new Date(guess).toISOString().replace('.000Z', 'Z')
}

const fmtOffset = (minutes) => {
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Structured-output schemas

const BRIEF_SCHEMA = {
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

const DISCOVERY_SCHEMA = {
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

const COMPOSER_SCHEMA = {
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

const BRIEF_SYSTEM = 'You are the Trip Brief Agent in a travel-planning pipeline. Turn a one-sentence trip request into a structured brief. Interpret conservatively; record every assumption (dates, pace, traveller count) in notes. Dates must be in the future relative to today.'

export async function runTripBriefAgent(ctx, sentence, todayIso) {
  const prompt = `Today is ${todayIso}. Trip request: ${sentence}`
  if (ctx.backend === 'cli') {
    return runCliJson({ system: BRIEF_SYSTEM, prompt, schema: BRIEF_SCHEMA })
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

const DISCOVERY_SYSTEM = 'You are the Local Discovery Agent in a travel-planning pipeline. Research the destination with web search: key sights, food areas, and transport legs between bases. Prefer official sources (tourism boards, railway operators, attraction sites). Every transport leg and weather/season-dependent sight should cite a source. Keep the list practical: roughly 3-5 POIs per base, not an encyclopedia.'

export async function runLocalDiscoveryAgent(ctx, brief) {
  const prompt = `Trip brief:\n${JSON.stringify(brief, null, 2)}`
  if (ctx.backend === 'cli') {
    return runCliJson({ system: DISCOVERY_SYSTEM, prompt, schema: DISCOVERY_SCHEMA, webSearch: true })
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

export function runTimezoneAgent(brief) {
  const { home_timezone: htz, destination_timezone: dtz, start_date, end_date } = brief
  const startIso = `${start_date}T12:00:00Z`
  const endIso = `${end_date}T12:00:00Z`
  const offsets = {
    destination_start: tzOffsetMinutes(dtz, startIso),
    destination_end: tzOffsetMinutes(dtz, endIso),
    home_start: tzOffsetMinutes(htz, startIso),
    home_end: tzOffsetMinutes(htz, endIso),
  }
  const dstChange = offsets.destination_start !== offsets.destination_end
    || offsets.home_start !== offsets.home_end
  const diffHours = (offsets.destination_start - offsets.home_start) / 60
  const ahead = diffHours >= 0
  const rule = diffHours === 0
    ? 'Destination shares the home timezone in this period.'
    : `Destination is ${Math.abs(diffHours)} hour(s) ${ahead ? 'ahead of' : 'behind'} home in this period. ${ahead ? 'Subtract' : 'Add'} ${Math.abs(diffHours)} hour(s) from local time to get body-clock time.`
  return {
    home_timezone: htz,
    destination_timezone: dtz,
    destination_offset: fmtOffset(offsets.destination_start),
    home_offset: fmtOffset(offsets.home_start),
    diff_hours: diffHours,
    dst_change_during_trip: dstChange,
    body_clock_rule: dstChange ? `${rule} Note: a DST change occurs during the trip window.` : rule,
  }
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

export async function runComposerAgent(ctx, { sentence, brief, timezone, discovery, context, calendar }) {
  const composerSystem = [
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
  const prompt = [
    `Original request: ${sentence}`,
    `Trip brief:\n${JSON.stringify(brief, null, 2)}`,
    `Timezone analysis:\n${JSON.stringify(timezone, null, 2)}`,
    `Local discovery:\n${JSON.stringify(discovery, null, 2)}`,
    `Travel context (bookings): ${JSON.stringify(context)}`,
    `Calendar (fixed events): ${JSON.stringify(calendar)}`,
  ].join('\n\n')
  if (ctx.backend === 'cli') {
    return runCliJson({ system: composerSystem, prompt, schema: COMPOSER_SCHEMA })
  }
  const stream = ctx.client.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: COMPOSER_SCHEMA } },
    system: composerSystem,
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

// codex CLI backend — 海報生成主力（免 API key）。
// 2026-07-14 更正：codex-cli ≥0.144 已內建圖像生成工具，ChatGPT 帳號 + gpt-5.6-luna
// 實測可生出高品質 typographic travel poster（codex 先存到 ~/.codex/generated_images/
// 再自行複製到 outPath）。先前「codex 無生圖能力」的結論是被過時 CLI 誤導——當時獨立 CLI
// 是 0.142.5，gpt-5.6-luna 回 400（"requires a newer version of Codex"），升級到 0.144.x 即通。
// （ChatGPT.app 內建的 codex 一直是新版，所以 App 裡看得到生圖。）
// CLI 太舊、或帳號不支援任何可生圖模型時仍會 throw，orchestrator 會往下降級。
function posterViaCodex(prompt, outPath) {
  execFileSync('codex', ['exec', '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox', '-C', path.dirname(outPath),
    `${prompt}\n\nSave the generated image as a PNG file at exactly this path: ${outPath}. Do not ask questions.`],
    { timeout: 240_000, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  // codex exec 就算 exit 0 也可能沒真的生圖（CLI 太舊/降級時），所以驗真 PNG magic bytes。
  if (!fs.existsSync(outPath)) throw new Error('codex exec finished but produced no PNG')
  const head = fs.readFileSync(outPath).subarray(0, 8)
  const isPng = head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (!isPng) throw new Error('codex exec wrote a file that is not a valid PNG')
}

async function posterViaGemini(prompt, outPath) {
  const key = process.env.GEMINI_API_KEY
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { imageConfig: { aspectRatio: '3:2' } },
      }),
    },
  )
  if (!res.ok) throw new Error(`Gemini image API ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = await res.json()
  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
  if (!part) throw new Error('Gemini response contained no inline image data')
  fs.writeFileSync(outPath, Buffer.from(part.inlineData.data, 'base64'))
}

// Poster Agent — 記念票畫版生圖。backend 自動選擇（仿 LLM backend 的降級哲學）：
// codex CLI → Gemini API → manual（不生圖，prompt 交給使用者）。
// POSTER_BACKEND=codex|gemini|manual|off 可強制。任何失敗都往下層降，最後誠實 skip。
export async function runPosterAgent({ city, landmarks, themeName, outPath }) {
  const palette = mergedTokens(themeName)
  const prompt = posterPrompt({ city, landmarks, palette })
  const forced = process.env.POSTER_BACKEND
  if (forced === 'off') return { status: 'skipped', notes: 'POSTER_BACKEND=off.', prompt }

  const hasCodex = (() => {
    try { execFileSync('which', ['codex'], { stdio: 'ignore' }); return true }
    catch { return false }
  })()
  const order = forced ? [forced]
    : [hasCodex && 'codex', process.env.GEMINI_API_KEY && 'gemini', 'manual'].filter(Boolean)

  // 只有真的會寫檔的層（codex/gemini）才建目錄；manual/off/skip 不留空的 data/posters/。
  const errors = []
  for (const backend of order) {
    if (backend === 'manual') {
      return { status: 'skipped', prompt,
        notes: `No image backend available (${errors.join('; ') || 'no codex CLI, no GEMINI_API_KEY'}). Poster prompt saved to cover.poster_prompt — generate manually and save to ${outPath}, then re-render.` }
    }
    try {
      if (backend !== 'codex' && backend !== 'gemini') {
        // 未知/設錯的 backend（例如 POSTER_BACKEND 打錯字）不得回報成功；
        // throw 進 errors，最後誠實 skip，避免產生指向不存在檔案的 cover.poster。
        throw new Error(`unknown backend ${backend}`)
      }
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
      if (backend === 'codex') posterViaCodex(prompt, outPath)
      if (backend === 'gemini') await posterViaGemini(prompt, outPath)
      return { backend, prompt }
    } catch (error) {
      errors.push(`${backend}: ${error.message}`)
    }
  }
  return { status: 'skipped', notes: errors.join('; '), prompt }
}
