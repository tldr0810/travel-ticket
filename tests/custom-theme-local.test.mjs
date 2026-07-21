import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateCustomTheme } from '../pipeline/customTheme-local.mjs'

test('customTheme-local reads the real prompts/city-theme.txt and fills it in for the llm call', async () => {
  let seenPrompt
  const llm = async (req) => { seenPrompt = req.prompt; return { name: 'x', tokens: {} } }
  await generateCustomTheme({ destination: 'Kyoto', style: 'teal', llm })
  assert.ok(seenPrompt.includes('Kyoto'))
  assert.ok(!seenPrompt.includes('{{DESTINATION}}'))
})
