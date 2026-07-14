// Custom ticket theme: generate via LLM prompt → gate (format + contrast) →
// one repair retry → honest fallback. Ephemeral by design: results are NEVER
// registered into themes.mjs; promotion to preset is a manual maintainer ritual.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkTokens, validateOverrides } from './contrast.mjs'
import { DEFAULT_TOKENS } from './themes.mjs'

export const CUSTOM_ALLOWED_KEYS = ['rail', 'rail-deep', 'rail-press', 'stamp', 'night', 'gold', 'green', 'blue', 'board', 'board-hi', 'board-lo', 'board-edge']

const PROMPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts', 'city-theme.txt')

const THEME_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    tokens: { type: 'object', additionalProperties: { type: 'string' } },
    motifs: { type: 'object', properties: { stampText: { type: 'string' }, eyebrow: { type: 'string' } } },
    rationale: { type: 'string' },
  },
  required: ['name', 'tokens'],
}

const gate = (tokens) => {
  const v = validateOverrides(tokens, CUSTOM_ALLOWED_KEYS)
  if (!v.ok) return { pass: false, failures: v.problems.map((p) => ({ label: p, ratio: 0, need: 0 })) }
  return checkTokens({ ...DEFAULT_TOKENS, ...tokens })
}

export async function generateCustomTheme({ destination, style, llm }) {
  const template = fs.readFileSync(PROMPT_PATH, 'utf8')
  const prompt = template.replace('{{DESTINATION}}', destination).replace('{{USER_STYLE}}', style || '(none)')
  const system = 'You are the theme generator for a retro train-ticket travel product. Respond with strict JSON only.'
  let out
  try { out = await llm({ system, prompt, schema: THEME_SCHEMA }) } catch (e) {
    return { ok: false, reason: `theme generation failed: ${e.message}`, failures: [] }
  }
  let check = gate(out?.tokens ?? {})
  if (check.pass) return { ok: true, tokens: out.tokens, motifs: out.motifs ?? {}, name: out.name, rationale: out.rationale ?? '' }

  // one repair retry: feed the failing pairs back
  const repairPrompt = `${prompt}\n\nYour previous attempt FAILED these contrast checks — darken/desaturate the involved colors and return corrected full JSON:\n${JSON.stringify(check.failures)}\nPrevious tokens: ${JSON.stringify(out?.tokens ?? {})}`
  try { out = await llm({ system, prompt: repairPrompt, schema: THEME_SCHEMA }) } catch (e) {
    return { ok: false, reason: `theme repair failed: ${e.message}`, failures: check.failures }
  }
  check = gate(out?.tokens ?? {})
  if (check.pass) return { ok: true, tokens: out.tokens, motifs: out.motifs ?? {}, name: out.name, rationale: out.rationale ?? '' }
  return { ok: false, reason: 'contrast gate failed after repair', failures: check.failures }
}
