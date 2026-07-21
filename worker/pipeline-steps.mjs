// Plain, directly-Node-testable step functions for the Cloudflare Workflow
// (worker/pipeline-workflow.ts). Each function is self-contained — its own
// local agentStatuses array + supervise call — so its return value is a
// plain, structured-clone-safe object usable as a step.do() result.
//
// Mirrors pipeline/trip.mjs's planTrip/renderTicket step-by-step (same
// fallback semantics: brief hard-fails, timezone/discovery/composer/theme
// all have honest fallbacks), minus mock mode, poster generation, and the
// CLI's dual dist-root render — spec §3 has neither; this Worker only ever
// serves a trip via /trips/<slug>/* out of KV.
//
// Zero node: imports (transitively, via agents.mjs/trip-core.mjs/render.mjs/
// customTheme.mjs/themes.mjs/storage.mjs, all already Worker-safe) — guarded
// by tests/worker/pipeline-steps.test.mjs.
import {
  runTripBriefAgent, runLocalDiscoveryAgent, runTravelContextAgent,
  runCalendarAgent, runNotionAgent, runComposerAgent, runTimezoneAgent,
  runStructuredJson,
} from '../pipeline/agents.mjs'
import { makeSupervisor, localCompose, customMotifsFrom } from '../pipeline/trip-core.mjs'
import { generateCustomTheme } from '../pipeline/customTheme.mjs'
import { resolveTheme } from '../pipeline/themes.mjs'
import { buildItineraryFiles } from '../pipeline/render.mjs'
import { saveTripFiles, saveTripJson, writeStatus } from './storage.mjs'

const noopLog = () => {}

export async function runBriefStep(ctx, sentence, todayIso) {
  const statuses = []
  const { supervise } = makeSupervisor(statuses, noopLog)
  const run = await supervise('Trip Brief Agent', () => runTripBriefAgent(ctx, sentence, todayIso), { confidence: 0.9 })
  if (!run.ok) throw new Error('Trip Brief Agent failed — cannot continue without a brief.')
  return { statuses, brief: run.result }
}

export async function runTimezoneStep(brief) {
  const statuses = []
  const { supervise } = makeSupervisor(statuses, noopLog)
  const run = await supervise('Timezone Agent', async () => runTimezoneAgent(brief), { confidence: 0.99 })
  const timezone = run.ok ? run.result : runTimezoneAgent({ ...brief, destination_timezone: 'UTC', home_timezone: 'UTC' })
  return { statuses, timezone }
}

export async function runDiscoveryStep(ctx, brief) {
  const statuses = []
  const { supervise } = makeSupervisor(statuses, noopLog)
  const run = await supervise('Local Discovery Agent', () => runLocalDiscoveryAgent(ctx, brief), { confidence: 0.8 })
  const discovery = run.ok ? run.result : { pois: [], transports: [], sources: [] }
  return { statuses, discovery }
}

export async function runGmailStep(ctx, brief, deps = {}) {
  const statuses = []
  const { supervise } = makeSupervisor(statuses, noopLog)
  const run = await supervise('Travel Context Agent', () => runTravelContextAgent(ctx, brief, deps))
  return { statuses, context: run.result }
}

export async function runCalendarStep(ctx, brief, deps = {}) {
  const statuses = []
  const { supervise } = makeSupervisor(statuses, noopLog)
  const run = await supervise('Calendar Agent', () => runCalendarAgent(ctx, brief, deps))
  return { statuses, calendar: run.result }
}

export async function runNotionStep(ctx, brief, deps = {}) {
  const statuses = []
  const { supervise } = makeSupervisor(statuses, noopLog)
  const run = await supervise('Notion Agent', () => runNotionAgent(ctx, brief, deps))
  return { statuses, notion: run.result }
}

export async function runComposerStep(ctx, { sentence, brief, timezone, discovery, context, calendar }) {
  const statuses = []
  const { supervise, recordStatus } = makeSupervisor(statuses, noopLog)
  const run = await supervise('Itinerary Composer Agent', () => runComposerAgent(ctx, { sentence, brief, timezone, discovery, context, calendar }), { confidence: 0.85 })
  if (run.ok) return { statuses, composed: run.result }
  const composed = localCompose(brief, discovery)
  recordStatus('Orchestrator Fallback Composer', 'completed', 0.5, 'Composer agent unavailable; itinerary composed locally.')
  return { statuses, composed }
}

// design: {kind:'preset', name} | {kind:'custom', style} | undefined. Never
// throws — a failed/ungated custom generation falls back to the resolved
// preset, exactly like trip.mjs's renderTicket.
export async function runThemeStep(ctx, { design, brief, promptTemplate }) {
  const themeName = resolveTheme({
    theme: design?.kind === 'preset' ? design.name : undefined,
    destination_timezone: brief.destination_timezone,
    destination: brief.destination,
  })
  if (design?.kind !== 'custom') {
    return { themeName, customTokens: null, customMotifs: null, themeUsed: { name: themeName } }
  }
  let result
  try {
    result = await generateCustomTheme({ destination: brief.destination, style: design.style, llm: (req) => runStructuredJson(ctx, req), promptTemplate })
  } catch (e) {
    result = { ok: false, reason: `theme generation failed: ${e.message}`, failures: [] }
  }
  if (result.ok) {
    return {
      themeName: 'default', // registered base; custom tokens override at render time
      customTokens: result.tokens,
      customMotifs: customMotifsFrom({ custom_theme: { motifs: result.motifs } }),
      themeUsed: { name: result.name, custom: true, rationale: result.rationale },
    }
  }
  return {
    themeName,
    customTokens: null,
    customMotifs: null,
    themeUsed: { name: themeName, fallback_reason: result.reason, failures: result.failures ?? [] },
  }
}

export async function runRenderStep(env, itinerary, { customTokens, customMotifs }) {
  const { pages, files } = await buildItineraryFiles(itinerary, { customTokens, customMotifs, hasPoster: false })
  await saveTripFiles(env, itinerary.trip_id, files)
  await saveTripJson(env, itinerary.trip_id, itinerary)
  return { pageCount: pages.length }
}

export async function runManifestStep(env, tripId, status) {
  await writeStatus(env, tripId, status)
  return status
}

// Reduces the Workflow's running agentStatuses log into the {agents, log}
// shape worker/routes/status.mjs polls — mirrors server.mjs/studio.html's
// existing {phase, agents, log, manifest, error} status contract (agents:
// name -> latest status string; log: human-readable "name: notes" lines) so
// the progress page's polling logic ports with minimal changes, per the plan.
export function summarizeAgentStatuses(agentStatuses) {
  const agents = {}
  const log = []
  for (const s of agentStatuses) {
    agents[s.agent] = s.status
    log.push(`${s.agent}: ${s.notes}`)
  }
  return { agents, log }
}
