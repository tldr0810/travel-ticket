// fs-reading wrapper around customTheme.mjs's portable generateCustomTheme —
// kept in its own file so customTheme.mjs itself has zero node: imports and
// stays Worker-safe (mirrors the agents.mjs / agents-local.mjs split).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateCustomTheme as generateCustomThemeCore } from './customTheme.mjs'

const PROMPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts', 'city-theme.txt')

export async function generateCustomTheme(args) {
  let promptTemplate
  try { promptTemplate = fs.readFileSync(PROMPT_PATH, 'utf8') } catch (e) {
    return { ok: false, reason: `prompt template missing: ${e.message}`, failures: [] }
  }
  return generateCustomThemeCore({ ...args, promptTemplate })
}

export { CUSTOM_ALLOWED_KEYS } from './customTheme.mjs'
