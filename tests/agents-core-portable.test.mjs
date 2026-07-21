import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const agentsPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pipeline', 'agents.mjs')

test('agents.mjs (the portable core) has no node: builtin imports', () => {
  const src = fs.readFileSync(agentsPath, 'utf8')
  const staticImports = [...src.matchAll(/^import\s.*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
  const nodeBuiltins = staticImports.filter((spec) => spec.startsWith('node:'))
  assert.deepEqual(nodeBuiltins, [], `agents.mjs must stay Worker-safe — found node: imports: ${nodeBuiltins.join(', ')}`)
})
