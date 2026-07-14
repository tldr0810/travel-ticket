#!/usr/bin/env node
// trip-ticket MCP server — zero-dep stdio transport (newline-delimited JSON-RPC).
// stdout is protocol-only; all logs go to stderr.
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { planTrip, renderTicket, parseDesignChoice } from './trip.mjs'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const plansDir = path.join(packageRoot, '.trip_work', 'plans')

const TOOLS = [
  {
    def: {
      name: 'plan_trip',
      description: 'Plan a trip from a one-sentence request (runs LLM agents + optional Gmail/Calendar/Notion context; can take several minutes). Returns a plan_id and ticket design options. Call render_ticket next with the plan_id and a chosen design.',
      inputSchema: {
        type: 'object',
        properties: {
          sentence: { type: 'string', description: 'One-sentence trip request, e.g. "七月中帶另一半去瑞士五天,不租車"' },
          mock: { type: 'boolean', description: 'Use canned data, no LLM calls (testing only)' },
        },
        required: ['sentence'],
      },
    },
    handler: async ({ sentence, mock = false }) => {
      const { plan, designOptions } = await planTrip(sentence, { mock, log: (m) => console.error(`[plan_trip] ${m}`) })
      fs.mkdirSync(plansDir, { recursive: true })
      fs.writeFileSync(path.join(plansDir, `${plan.tripId}.json`), JSON.stringify({ plan, designOptions }))
      return {
        plan_id: plan.tripId,
        destination: plan.brief.destination,
        dates: `${plan.brief.start_date} → ${plan.brief.end_date}`,
        summary: plan.composed.summary,
        design_options: designOptions,
        next_step: `Ask the user which design they want, then call render_ticket with plan_id and design (a preset name, or "custom:<their description>").`,
      }
    },
  },
  {
    def: {
      name: 'render_ticket',
      description: 'Render the ticket site for a planned trip. design = a preset name from plan_trip\'s design_options, or "custom:<style description>" (contrast-gated; falls back honestly), or omit for the top recommendation.',
      inputSchema: {
        type: 'object',
        properties: {
          plan_id: { type: 'string' },
          design: { type: 'string' },
        },
        required: ['plan_id'],
      },
    },
    handler: async ({ plan_id, design }) => {
      const file = path.join(plansDir, `${path.basename(plan_id)}.json`)
      if (!fs.existsSync(file)) throw new Error(`unknown plan_id: ${plan_id} — call plan_trip first`)
      const { plan, designOptions } = JSON.parse(fs.readFileSync(file, 'utf8'))
      const choice = parseDesignChoice(design, designOptions)
      const outDir = path.join(packageRoot, 'dist', 'trips')
      const { manifest, tripDir, themeUsed } = await renderTicket(plan, choice, { log: (m) => console.error(`[render_ticket] ${m}`) })
      return {
        output_dir: path.join(outDir, tripDir),
        entry: path.join(outDir, tripDir, 'index.html'),
        theme_used: themeUsed,
        trip_dir: tripDir,
        pages: manifest.pages?.length ?? 0,
      }
    },
  },
]

const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
const replyError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } })

const handlers = {
  initialize: (params) => ({
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'trip-ticket', version: '0.1.0' },
  }),
  'tools/list': () => ({ tools: TOOLS.map((t) => t.def) }),
  'tools/call': async (params) => {
    const tool = TOOLS.find((t) => t.def.name === params?.name)
    if (!tool) throw Object.assign(new Error(`unknown tool: ${params?.name}`), { code: -32602 })
    try {
      const result = await tool.handler(params?.arguments ?? {})
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (error) {
      return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true }
    }
  },
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return replyError(null, -32700, 'parse error') }
  if (msg.method?.startsWith('notifications/')) return // no response to notifications
  const handler = handlers[msg.method]
  if (!handler) return replyError(msg.id ?? null, -32601, `method not found: ${msg.method}`)
  try {
    reply(msg.id, await handler(msg.params))
  } catch (error) {
    replyError(msg.id ?? null, error.code ?? -32603, error.message)
  }
})
process.stdin.on('end', () => process.exit(0))
