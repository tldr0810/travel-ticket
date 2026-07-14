#!/usr/bin/env node
// Orchestrator: one-sentence trip request → multi-agent pipeline → ticket-style
// itinerary site.
//
//   node pipeline/orchestrator.mjs "七月中帶另一半去瑞士五天，不租車不要太趕"
//   node pipeline/orchestrator.mjs --mock          # no API calls, canned data
//
// Flow:
//   Trip Brief Agent (LLM)
//     ├─ Timezone Agent (pure code)
//     ├─ Local Discovery Agent (LLM + web search)
//     ├─ Travel Context Agent (Gmail via Composio MCP)
//     └─ Calendar Agent (Google Calendar via Composio MCP)
//   Itinerary Composer Agent (LLM) — falls back to a local composer on
//   timeout/failure, mirroring how the demo artifact was produced.
//
// Outputs: .trip_work/final_itinerary.json, data/final_itinerary.json, dist/
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  createContext,
  runTripBriefAgent,
  runLocalDiscoveryAgent,
  runTimezoneAgent,
  runTravelContextAgent,
  runCalendarAgent,
  runNotionAgent,
  runComposerAgent,
  runPosterAgent,
  localToUtc,
} from './agents.mjs'
import { resolveTheme } from './themes.mjs'
import { renderItinerary } from './render.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// CLI

const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const sentence = args.filter((a) => !a.startsWith('--')).join(' ').trim()
const mock = flags.has('--mock')
const skipRender = flags.has('--no-render')
const backendFlag = args.find((a) => a.startsWith('--backend='))?.split('=')[1]
const renderOnly = flags.has('--render-only')

// 票夾：每份 trip 的資料夾名 = slug + trip id 短碼（同 slug 不同 run 不互撞）。
const tripDirName = (itin) => `${itin.slug || 'trip'}-${String(itin.trip_id || '').split('_').at(-1).slice(0, 4)}`
const tripsDataDir = path.join(packageRoot, 'data', 'trips')
const saveTripJson = (itin) => {
  fs.mkdirSync(tripsDataDir, { recursive: true })
  fs.writeFileSync(path.join(tripsDataDir, `${tripDirName(itin)}.json`), JSON.stringify(itin, null, 2))
}

// 票夾清理：--prune[=N] 保留最新 N 份（預設 10），較舊的 data/trips json 與
// dist/trips 目錄一起刪（wallet 以 data/trips 為準，兩邊要同步）。壞 json 不動。
const pruneFlag = args.find((a) => a === '--prune' || a.startsWith('--prune='))
if (pruneFlag) {
  const keep = Math.max(1, Number(pruneFlag.split('=')[1] ?? 10) || 10)
  const files = fs.existsSync(tripsDataDir) ? fs.readdirSync(tripsDataDir).filter((f) => f.endsWith('.json')) : []
  const byNewest = files
    .map((f) => {
      try { return { f, trip_id: JSON.parse(fs.readFileSync(path.join(tripsDataDir, f), 'utf8')).trip_id } }
      catch { return null } // 壞 json 不進排序、也不會被刪
    })
    .filter(Boolean)
    .sort((a, b) => String(b.trip_id).localeCompare(String(a.trip_id)))
  const drop = byNewest.slice(keep)
  for (const { f, trip_id } of drop) {
    // trip_id 已在 byNewest 解析過（壞 json 早被濾掉），直接用、不重讀。
    if (trip_id) fs.rmSync(path.join(packageRoot, 'data', 'posters', `${trip_id}.png`), { force: true })
    fs.rmSync(path.join(tripsDataDir, f))
    fs.rmSync(path.join(packageRoot, 'dist', 'trips', f.replace(/\.json$/, '')), { recursive: true, force: true })
    console.error(`[orchestrator] pruned ${f} (+ dist/trips/${f.replace(/\.json$/, '')})`)
  }
  console.log(JSON.stringify({ pruned: drop.length, kept: Math.min(keep, byNewest.length) }, null, 2))
  process.exit(0)
}

if (renderOnly) {
  // Re-render without re-running agents. 預設重印最新一份（dist 根 + 它的票夾目錄）；
  // --trip=<slug 或前綴> 只重印票夾裡指定那份。
  const tripFlag = args.find((a) => a.startsWith('--trip='))?.split('=')[1]
  if (tripFlag) {
    const tripFiles = fs.existsSync(tripsDataDir) ? fs.readdirSync(tripsDataDir) : []
    const match = tripFiles.includes(`${tripFlag}.json`)
      ? `${tripFlag}.json`
      : tripFiles.find((f) => f.startsWith(tripFlag) && f.endsWith('.json'))
    if (!match) {
      console.error(`[orchestrator] no trip matching "${tripFlag}" in data/trips/${tripFiles.length ? '' : ' (資料夾不存在或是空的——先跑一次出票或 --render-only)'}`)
      process.exit(1)
    }
    const itinerary = JSON.parse(fs.readFileSync(path.join(tripsDataDir, match), 'utf8'))
    const dir = tripDirName(itinerary)
    const manifest = renderItinerary(itinerary, { outDir: path.join(packageRoot, 'dist', 'trips', dir) })
    console.log(JSON.stringify({ ...manifest, trip_dir: dir }, null, 2))
    process.exit(0)
  }
  const latestPath = path.join(packageRoot, 'data', 'final_itinerary.json')
  if (!fs.existsSync(latestPath)) {
    console.error('[orchestrator] data/final_itinerary.json 不存在——先跑一次出票才有東西可重印')
    process.exit(1)
  }
  const itinerary = JSON.parse(fs.readFileSync(latestPath, 'utf8'))
  saveTripJson(itinerary) // 自我遷移：舊資料第一次重印時進票夾
  const dir = tripDirName(itinerary)
  const manifest = renderItinerary(itinerary, { outDir: path.join(packageRoot, 'dist') })
  renderItinerary(itinerary, { outDir: path.join(packageRoot, 'dist', 'trips', dir) })
  console.log(JSON.stringify({ ...manifest, trip_dir: dir }, null, 2))
  process.exit(0)
}

if (!sentence && !mock) {
  console.error('Usage: node pipeline/orchestrator.mjs "一句話描述你的旅程" [--mock] [--no-render]')
  process.exit(1)
}

const log = (msg) => console.error(`[orchestrator] ${msg}`)

// ---------------------------------------------------------------------------
// Agent supervision: every agent runs under a timeout and reports a status
// entry regardless of outcome.

const TIMEOUTS = {
  'Trip Brief Agent': 120_000,
  'Local Discovery Agent': 420_000,
  'Travel Context Agent': 60_000,
  'Calendar Agent': 60_000,
  'Notion Agent': 60_000,
  'Itinerary Composer Agent': 600_000,
  'Poster Agent': 300_000,
}

const agentStatuses = []
const recordStatus = (agent, status, confidence, notes) => {
  agentStatuses.push({ agent, status, confidence, notes })
}

async function supervise(agent, run, { confidence = 0.9 } = {}) {
  const startedAt = Date.now()
  let timer
  try {
    const result = await Promise.race([
      run(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), TIMEOUTS[agent] ?? 120_000)
      }),
    ])
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    if (result && typeof result === 'object' && result.status === 'skipped') {
      recordStatus(agent, 'skipped', 0, result.notes)
      log(`${agent}: skipped (${result.notes})`)
    } else {
      recordStatus(agent, 'completed', confidence, `Completed in ${seconds}s.`)
      log(`${agent}: completed in ${seconds}s`)
    }
    return { ok: true, result }
  } catch (error) {
    const status = error.code === 'timeout' ? 'timeout' : 'failed'
    recordStatus(agent, status, 0, `${error.message}`)
    log(`${agent}: ${status} (${error.message})`)
    return { ok: false, error }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Local fallback composer — used when the Composer agent fails or in --mock
// mode. Deterministic and unspectacular, but always yields a renderable plan.

function localCompose(brief, discovery) {
  const days = []
  const start = new Date(`${brief.start_date}T00:00:00Z`)
  const end = new Date(`${brief.end_date}T00:00:00Z`)
  const totalDays = Math.round((end - start) / 86_400_000) + 1

  // Assign a base to each day from brief.bases (nights), last day = returning.
  const baseByDay = []
  let cursor = 0
  for (const base of brief.bases ?? []) {
    for (let n = 0; n < base.nights; n++) baseByDay[cursor++] = base.name
  }
  while (baseByDay.length < totalDays) baseByDay.push(baseByDay.at(-1) ?? brief.destination)

  const poisByBase = new Map()
  for (const poi of discovery?.pois ?? []) {
    if (!poisByBase.has(poi.base)) poisByBase.set(poi.base, [])
    poisByBase.get(poi.base).push(poi)
  }

  for (let i = 0; i < totalDays; i++) {
    const date = new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10)
    const base = baseByDay[i]
    const previousBase = i === 0 ? brief.home_city : baseByDay[i - 1]
    const isArrival = i === 0
    const isDeparture = i === totalDays - 1
    const isTransfer = !isArrival && !isDeparture && base !== previousBase
    const items = []
    const pois = poisByBase.get(base) ?? []

    if (isArrival) {
      items.push({ variant: 'both', type: 'travel', title: `${brief.home_city} → ${base}`, start_local: '09:00', end_local: '16:00', location: `${brief.home_city} → ${base}`, transport_minutes: 420, notes: 'Planning placeholder — verify schedules before booking.', sources: [] })
      items.push({ variant: 'both', type: 'rest', title: 'Check-in and rest', start_local: '16:30', end_local: '18:00', location: `${base} accommodation TBD`, transport_minutes: 0, notes: 'Accommodation not confirmed.', sources: [] })
      items.push({ variant: 'both', type: 'meal', title: 'Easy dinner near the hotel', start_local: '18:30', end_local: '20:00', location: base, transport_minutes: 0, notes: 'Arrival day stays light.', sources: [] })
    } else if (isDeparture) {
      items.push({ variant: 'both', type: 'travel', title: `${base} → ${brief.home_city}`, start_local: '09:00', end_local: '17:00', location: `${base} → ${brief.home_city}`, transport_minutes: 480, notes: 'Planning placeholder — keep the morning free.', sources: [] })
      items.push({ variant: 'both', type: 'rest', title: 'Home buffer', start_local: '18:00', end_local: '19:00', location: brief.home_city, transport_minutes: 0, notes: 'No evening plans after a travel day.', sources: [] })
    } else {
      let clock = 9 * 60
      if (isTransfer) {
        const leg = (discovery?.transports ?? []).find((t) => t.from.includes(previousBase) && t.to.includes(base))
        const minutes = leg?.minutes ?? 120
        items.push({ variant: 'both', type: 'travel', title: `${previousBase} → ${base}`, start_local: '09:00', end_local: minuteToHHMM(9 * 60 + minutes), location: `${previousBase} → ${base}`, transport_minutes: minutes, notes: leg?.notes ?? 'Planning placeholder.', sources: leg?.source_label ? [leg.source_label] : [] })
        clock = 9 * 60 + minutes + 30
      }
      const [morningPoi, afternoonPoi] = [pois[(i * 2) % Math.max(pois.length, 1)], pois[(i * 2 + 1) % Math.max(pois.length, 1)]]
      if (morningPoi) {
        items.push({ variant: 'both', type: morningPoi.kind === 'meal' ? 'meal' : 'sight', title: morningPoi.title, start_local: minuteToHHMM(clock), end_local: minuteToHHMM(clock + (morningPoi.duration_minutes || 120)), location: base, transport_minutes: 0, notes: morningPoi.notes, sources: morningPoi.source_label ? [morningPoi.source_label] : [] })
        clock += (morningPoi.duration_minutes || 120) + 15
      }
      items.push({ variant: 'both', type: 'meal', title: 'Lunch', start_local: minuteToHHMM(Math.max(clock, 12 * 60)), end_local: minuteToHHMM(Math.max(clock, 12 * 60) + 75), location: base, transport_minutes: 0, notes: '', sources: [] })
      clock = Math.max(clock, 12 * 60) + 75 + 15
      items.push({ variant: 'relaxed', type: 'rest', title: 'Coffee / slow afternoon', start_local: minuteToHHMM(clock), end_local: minuteToHHMM(clock + 90), location: base, transport_minutes: 0, notes: 'Relaxed variant keeps the afternoon open.', sources: [] })
      if (afternoonPoi && afternoonPoi !== morningPoi) {
        items.push({ variant: 'full', type: afternoonPoi.kind === 'meal' ? 'meal' : 'sight', title: afternoonPoi.title, start_local: minuteToHHMM(clock), end_local: minuteToHHMM(clock + (afternoonPoi.duration_minutes || 150)), location: base, transport_minutes: 0, notes: afternoonPoi.notes, sources: afternoonPoi.source_label ? [afternoonPoi.source_label] : [] })
      }
      items.push({ variant: 'both', type: 'meal', title: 'Dinner', start_local: '19:00', end_local: '20:30', location: base, transport_minutes: 0, notes: 'Keep evenings light.', sources: [] })
    }

    days.push({
      date,
      title: isArrival ? `${brief.home_city} → ${base}` : isDeparture ? `${base} → ${brief.home_city}` : isTransfer ? `${previousBase} → ${base}` : `${base} day`,
      base: isDeparture ? brief.home_city : base,
      items,
    })
  }

  return {
    summary: `${brief.destination} — ${totalDays}-day plan composed locally by the orchestrator (Composer agent unavailable). Pace: ${brief.pace}. ${brief.notes}`,
    warnings: [
      'Composed by the orchestrator fallback — schedules are placeholders, verify everything before booking.',
      'No bookings or calendar events were checked.',
    ],
    days,
    alternatives: {
      relaxed: { notes: 'Keep only the shared items and the slow-afternoon blocks.' },
      full: { notes: 'Add the "full" variant sights when energy and weather allow.' },
    },
    actions_suggested: [
      { type: 'booking_check', title: 'Verify transport schedules', description: 'All transport legs are placeholders.', requires_approval: true },
      { type: 'booking_check', title: 'Confirm accommodation', description: `Bases: ${(brief.bases ?? []).map((b) => b.name).join(', ')}`, requires_approval: true },
    ],
    cover: {
      title_top: brief.destination.split(':')[0].trim(),
      title_accent: 'Itinerary',
      eyebrow: 'Ticket stack · UTC-first preview',
    },
  }
}

const minuteToHHMM = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

// ---------------------------------------------------------------------------
// Mock inputs (plumbing test without API access)

const MOCK_BRIEF = {
  destination: 'Japan: Kyoto & Osaka',
  destination_timezone: 'Asia/Tokyo',
  home_city: 'Taipei',
  home_timezone: 'Asia/Taipei',
  start_date: '2026-09-10',
  end_date: '2026-09-13',
  travellers: 2,
  pace: 'relaxed',
  no_car: true,
  bases: [{ name: 'Kyoto', nights: 2 }, { name: 'Osaka', nights: 1 }],
  interests: ['food', 'temples'],
  language: 'zh-Hant',
  notes: 'Mock brief — fixed data for pipeline testing.',
}

const MOCK_DISCOVERY = {
  pois: [
    { title: 'Fushimi Inari 清晨參道', base: 'Kyoto', kind: 'sight', duration_minutes: 150, best_time: 'morning', notes: '早上人少。', source_label: 'Kyoto tourism' },
    { title: '錦市場午後散步', base: 'Kyoto', kind: 'sight', duration_minutes: 90, best_time: 'afternoon', notes: '邊走邊吃。', source_label: 'Kyoto tourism' },
    { title: '道頓堀晚餐', base: 'Osaka', kind: 'meal', duration_minutes: 120, best_time: 'evening', notes: '', source_label: 'Osaka info' },
    { title: '大阪城公園', base: 'Osaka', kind: 'sight', duration_minutes: 120, best_time: 'morning', notes: '', source_label: 'Osaka info' },
  ],
  transports: [
    { from: 'Kyoto', to: 'Osaka', mode: 'JR', minutes: 30, notes: 'JR 京都線新快速。', source_label: 'JR West' },
  ],
  sources: [
    { label: 'Kyoto tourism', url: 'https://kyoto.travel/en/' },
    { label: 'Osaka info', url: 'https://osaka-info.jp/en/' },
    { label: 'JR West', url: 'https://www.westjr.co.jp/global/en/' },
  ],
}

// ---------------------------------------------------------------------------
// Assembly

// 全 CJK 目的地會被字元過濾清空——fallback 'trip'，讓 slug 至少是 trip-<年份>。
const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'trip'

function assembleItinerary({ tripId, brief, timezone, discovery, composed, contextResult, calendarResult, notionResult, themeName, posterResult }) {
  const dtz = brief.destination_timezone
  const days = composed.days.map((day) => ({
    date: day.date,
    title: day.title,
    base: day.base,
    items: day.items.map((it) => ({
      variant: it.variant,
      type: it.type,
      title: it.title,
      start_utc: localToUtc(day.date, it.start_local, dtz),
      end_utc: localToUtc(day.date, it.end_local, dtz),
      timezone: dtz,
      location: it.location,
      transport_minutes: it.transport_minutes ?? 0,
      notes: it.notes ?? '',
      sources: it.sources ?? [],
    })),
  }))

  const itinerary = {
    artifact_type: 'final_itinerary',
    trip_id: tripId,
    status: agentStatuses.every((s) => s.status === 'completed') ? 'complete' : 'partial',
    destination: brief.destination,
    slug: `${slugify(brief.destination)}-${brief.start_date.slice(0, 4)}`,
    home_timezone: brief.home_timezone,
    destination_timezone: dtz,
    utc_timezone: 'UTC',
    travellers: brief.travellers,
    body_clock: {
      label: 'Body Clock',
      based_on_timezone: brief.home_timezone,
      rule: timezone.body_clock_rule,
    },
    summary: composed.summary,
    request: { sentence, brief },
    agent_statuses: agentStatuses,
    warnings: composed.warnings,
    sources: (discovery?.sources ?? []).map((s) => ({ ...s, agent: 'local_discovery', confidence: 0.72 })),
    days,
    alternatives: composed.alternatives,
    actions_suggested: composed.actions_suggested,
    theme: themeName,
    cover: {
      ...composed.cover,
      ...(posterResult?.backend ? { poster: 'poster.png' } : {}),
      ...(posterResult?.prompt ? { poster_prompt: posterResult.prompt } : {}),
    },
    context: { bookings: contextResult?.bookings ?? [], calendar_events: calendarResult?.events ?? [], travel_notes: notionResult?.travel_notes ?? [] },
  }

  itinerary.timeline_json = {
    timezones: [
      { id: dtz, label: 'Destination' },
      { id: brief.home_timezone, label: 'Home Timezone' },
      { id: 'UTC', label: 'UTC' },
      { id: 'body_clock', label: 'Body Clock', based_on: brief.home_timezone },
    ],
    events: days.flatMap((day) => day.items.map((it) => ({
      date: day.date,
      title: it.title,
      type: it.type,
      variant: it.variant,
      start_utc: it.start_utc,
      end_utc: it.end_utc,
      location: it.location,
      transport_minutes: it.transport_minutes,
    }))),
  }

  return itinerary
}

// ---------------------------------------------------------------------------
// Main

async function main() {
  const tripId = `trip_${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}_${crypto.randomBytes(4).toString('hex')}`
  const todayIso = new Date().toISOString().slice(0, 10)
  log(`trip ${tripId}${mock ? ' (mock mode)' : ''}`)

  const ctx = mock ? null : await createContext(backendFlag)
  if (ctx) log(`LLM backend: ${ctx.backend === 'cli' ? 'claude CLI (headless, Claude Code login)' : 'Anthropic API SDK'}`)

  // Stage 1 — brief
  let brief
  if (mock) {
    brief = MOCK_BRIEF
    recordStatus('Trip Brief Agent', 'completed', 1, 'Mock brief.')
    log('Trip Brief Agent: completed (mock)')
  } else {
    const briefRun = await supervise('Trip Brief Agent', () => runTripBriefAgent(ctx, sentence, todayIso), { confidence: 0.9 })
    if (!briefRun.ok) {
      console.error('Trip Brief Agent failed — cannot continue without a brief.')
      process.exit(1)
    }
    brief = briefRun.result
  }
  log(`brief: ${brief.destination}, ${brief.start_date} → ${brief.end_date}, ${brief.travellers} traveller(s), pace=${brief.pace}`)

  // Stage 2 — parallel context gathering
  const timezoneRun = await supervise('Timezone Agent', async () => runTimezoneAgent(brief), { confidence: 0.99 })
  const [discoveryRun, contextRun, calendarRun, notionRun] = await Promise.all([
    mock
      ? (recordStatus('Local Discovery Agent', 'completed', 1, 'Mock discovery.'), log('Local Discovery Agent: completed (mock)'), Promise.resolve({ ok: true, result: MOCK_DISCOVERY }))
      : supervise('Local Discovery Agent', () => runLocalDiscoveryAgent(ctx, brief), { confidence: 0.8 }),
    supervise('Travel Context Agent', () => runTravelContextAgent(ctx, brief)),
    supervise('Calendar Agent', () => runCalendarAgent(ctx, brief)),
    supervise('Notion Agent', () => runNotionAgent(ctx, brief)),
  ])

  const timezone = timezoneRun.ok ? timezoneRun.result : runTimezoneAgent({ ...brief, destination_timezone: 'UTC', home_timezone: 'UTC' })
  const discovery = discoveryRun.ok ? discoveryRun.result : { pois: [], transports: [], sources: [] }

  // Stage 3 — composer (LLM with local fallback)
  let composed
  if (mock) {
    composed = localCompose(brief, discovery)
    recordStatus('Itinerary Composer Agent', 'skipped', 0, 'Mock mode: composed locally by the orchestrator.')
    log('Itinerary Composer Agent: skipped (mock mode, composed locally)')
  } else {
    const composerRun = await supervise('Itinerary Composer Agent', () => runComposerAgent(ctx, {
      sentence, brief, timezone, discovery,
      context: { ...(contextRun.result ?? { bookings: [] }), travel_notes: notionRun.result?.travel_notes ?? [] },
      calendar: calendarRun.result,
    }), { confidence: 0.85 })
    if (composerRun.ok) {
      composed = composerRun.result
    } else {
      log('Composer failed — falling back to local composition.')
      composed = localCompose(brief, discovery)
      recordStatus('Orchestrator Fallback Composer', 'completed', 0.5, 'Composer agent unavailable; itinerary composed locally.')
    }
  }

  // Stage 3.5 — poster（記念票畫版）。city 取第一個 base，landmarks 取 Discovery 查證過的 POI。
  const themeName = resolveTheme({ destination_timezone: brief.destination_timezone, destination: brief.destination })
  const posterCity = composed.days?.[0]?.base
    || String(brief.destination || '').split(':').pop().split(/[&，,]/)[0].trim() || 'Trip'
  const posterLandmarks = (discovery.pois || []).slice(0, 6).map((p) => p.title).filter(Boolean)
  const posterOut = path.join(packageRoot, 'data', 'posters', `${tripId}.png`)
  let posterResult = null
  if (mock) {
    recordStatus('Poster Agent', 'skipped', 0, 'Mock mode: no image generation.')
    log('Poster Agent: skipped (mock)')
  } else {
    const posterRun = await supervise('Poster Agent', () => runPosterAgent({
      city: posterCity, landmarks: posterLandmarks, themeName, outPath: posterOut,
    }), { confidence: 0.7 })
    posterResult = posterRun.ok && !posterRun.result?.status ? posterRun.result : (posterRun.result ?? null)
  }

  // Assemble + persist
  const itinerary = assembleItinerary({
    tripId, brief, timezone, discovery, composed,
    contextResult: contextRun.result, calendarResult: calendarRun.result, notionResult: notionRun.result,
    themeName, posterResult,
  })

  fs.mkdirSync(path.join(packageRoot, '.trip_work'), { recursive: true })
  fs.mkdirSync(path.join(packageRoot, 'data'), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, '.trip_work', 'final_itinerary.json'), JSON.stringify(itinerary, null, 2))
  fs.writeFileSync(path.join(packageRoot, 'data', 'final_itinerary.json'), JSON.stringify(itinerary, null, 2))
  saveTripJson(itinerary)
  log('wrote .trip_work/final_itinerary.json, data/final_itinerary.json and data/trips/')

  let manifest = { artifact_type: 'final_itinerary', trip_id: tripId, preview_status: 'not_rendered' }
  if (!skipRender) {
    manifest = renderItinerary(itinerary, { outDir: path.join(packageRoot, 'dist') })
    renderItinerary(itinerary, { outDir: path.join(packageRoot, 'dist', 'trips', tripDirName(itinerary)) })
    log(`rendered ${manifest.pages.length} pages to dist/ (+ trips/${tripDirName(itinerary)})`)
  }

  console.log(JSON.stringify({
    ...manifest,
    trip_dir: tripDirName(itinerary),
    json_path: 'data/final_itinerary.json',
    agent_statuses: agentStatuses,
    deployment_status: 'awaiting_approval',
  }, null, 2))
}

main().catch((error) => {
  console.error('[orchestrator] fatal:', error)
  process.exit(1)
})
