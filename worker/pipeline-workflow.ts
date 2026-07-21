// Cloudflare Workflow entrypoint (Task 6). Thin orchestrator: every step's
// actual logic lives in the plain, Node-testable worker/pipeline-steps.mjs —
// this file only sequences step.do() calls and accumulates agent_statuses,
// mirroring pipeline/trip.mjs's planTrip/renderTicket order (spec §3):
// brief → timezone → discovery/gmail/calendar/notion (parallel) → composer →
// custom_theme (only if the guest picked one) → render → manifest.
//
// step.do() callbacks close over ctx/env/brief etc. freely — only the
// RETURN VALUE of each step.do() is persisted/replayed by the Workflows
// engine, so those closures are safe. tripId/todayIso are NOT generated here
// (Date.now()/crypto inside run() would be non-deterministic across a replay)
// — they're computed once by the route that kicks the workflow off (Task 7)
// and passed in via event.payload.
import { WorkflowEntrypoint } from 'cloudflare:workers'
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers'
import cityThemePrompt from '../pipeline/prompts/city-theme.txt'
import { createMfContext } from '../pipeline/agents.mjs'
import { mcpSession } from '../pipeline/composio.mjs'
import { assembleItinerary } from '../pipeline/trip-core.mjs'
import type { Env, TripWorkflowParams } from './env.d.ts'
import { writeStatus } from './storage.mjs'
import {
  runBriefStep, runTimezoneStep, runDiscoveryStep, runGmailStep, runCalendarStep,
  runNotionStep, runComposerStep, runThemeStep, runRenderStep, runManifestStep,
  summarizeAgentStatuses,
} from './pipeline-steps.mjs'

// Each agent already carries its own honest timeout/fallback (trip-core.mjs's
// supervise, per-agent TIMEOUTS) — a large Workflow-level retry count on top
// would just compound into a multi-minute hang before the guest sees a
// result. Kept small: only enough to absorb a transient Workflow-engine blip.
const STEP_CONFIG = { retries: { limit: 1, delay: '5 seconds', backoff: 'linear' as const }, timeout: '15 minutes' }

export class TripPipelineWorkflow extends WorkflowEntrypoint<Env, TripWorkflowParams> {
  async run(event: WorkflowEvent<TripWorkflowParams>, step: WorkflowStep) {
    const { tripId, sentence, todayIso, visitorId, design } = event.payload
    const env = this.env
    const agentStatuses: unknown[] = []

    // Plain (non-step.do) progress ping — derived only from already-resolved
    // step.do() results, so re-firing on a Workflow replay is harmless. This
    // is what makes "運行中" agent-by-agent progress visible on the progress
    // page (spec §2 step 3) instead of the status sitting on 'queued' for the
    // whole ~6 minute run and only ever flipping straight to done/error.
    const pingProgress = () => writeStatus(env, tripId, {
      phase: 'running', trip_id: tripId, ...summarizeAgentStatuses(agentStatuses), manifest: null, error: null,
    })

    let ctx, briefRes
    try {
      ctx = createMfContext(env)
      briefRes = await step.do('brief', STEP_CONFIG, () => runBriefStep(ctx, sentence, todayIso))
    } catch (error) {
      await step.do('manifest', () => runManifestStep(env, tripId, {
        phase: 'error',
        trip_id: tripId,
        ...summarizeAgentStatuses(agentStatuses),
        manifest: null,
        error: error instanceof Error ? error.message : String(error),
      }))
      throw error
    }
    agentStatuses.push(...briefRes.statuses)
    const brief = briefRes.brief
    await pingProgress()

    const timezoneRes = await step.do('timezone', STEP_CONFIG, () => runTimezoneStep(brief))
    agentStatuses.push(...timezoneRes.statuses)
    const timezone = timezoneRes.timezone
    await pingProgress()

    // authConfigId (per-connector OAuth setup) only matters for creating a new
    // connector link (Task 8's connect-accounts route) — reading an already-
    // connected session here only needs the account-level composioApiKey.
    // session is scoped to this guest's own visitorId — mcpSession never falls
    // back to a shared/implicit account (composio.mjs's requireVisitorId), so
    // this must be passed explicitly or every guest would see the same (empty)
    // COMPOSIO_USER_ID-keyed session.
    const composioDeps = {
      composioApiKey: env.COMPOSIO_API_KEY,
      session: () => mcpSession({ userId: visitorId, apiKey: env.COMPOSIO_API_KEY }),
    }
    const [discoveryRes, gmailRes, calendarRes, notionRes] = await Promise.all([
      step.do('discovery', STEP_CONFIG, () => runDiscoveryStep(ctx, brief)),
      step.do('gmail', STEP_CONFIG, () => runGmailStep(ctx, brief, composioDeps)),
      step.do('calendar', STEP_CONFIG, () => runCalendarStep(ctx, brief, composioDeps)),
      step.do('notion', STEP_CONFIG, () => runNotionStep(ctx, brief, composioDeps)),
    ])
    agentStatuses.push(...discoveryRes.statuses, ...gmailRes.statuses, ...calendarRes.statuses, ...notionRes.statuses)
    const discovery = discoveryRes.discovery
    await pingProgress()

    const composerRes = await step.do('composer', STEP_CONFIG, () => runComposerStep(ctx, {
      sentence, brief, timezone, discovery,
      context: { ...(gmailRes.context ?? { bookings: [] }), travel_notes: notionRes.notion?.travel_notes ?? [] },
      calendar: calendarRes.calendar,
    }))
    agentStatuses.push(...composerRes.statuses)
    const composed = composerRes.composed
    await pingProgress()

    const themeRes = design
      ? await step.do('custom_theme', STEP_CONFIG, () => runThemeStep(ctx, { design, brief, promptTemplate: cityThemePrompt }))
      : await runThemeStep(ctx, { design, brief, promptTemplate: cityThemePrompt }) // no LLM call when no guest choice — skip the step.do wrapper

    const itinerary = assembleItinerary({
      tripId, sentence, brief, timezone, discovery, composed,
      contextResult: gmailRes.context, calendarResult: calendarRes.calendar, notionResult: notionRes.notion,
      themeName: themeRes.themeName, posterResult: null, agentStatuses,
    })
    if (themeRes.themeUsed.custom) {
      itinerary.custom_theme = {
        name: themeRes.themeUsed.name,
        rationale: themeRes.themeUsed.rationale,
        tokens: themeRes.customTokens,
        motifs: themeRes.customMotifs ?? {},
      }
    }

    const renderRes = await step.do('render', STEP_CONFIG, () => runRenderStep(env, itinerary, {
      customTokens: themeRes.customTokens,
      customMotifs: themeRes.customMotifs,
    }))

    await step.do('manifest', STEP_CONFIG, () => runManifestStep(env, tripId, {
      phase: 'done',
      trip_id: tripId,
      ...summarizeAgentStatuses(agentStatuses),
      manifest: { slug: itinerary.slug, status: itinerary.status },
      error: null,
      page_count: renderRes.pageCount,
    }))

    return { tripId, slug: itinerary.slug, status: itinerary.status }
  }
}
