import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkTokens, validateOverrides, ratio } from '../pipeline/contrast.mjs'
import { mergedTokens } from '../pipeline/themes.mjs'

test('ratio: black on white ≈ 21', () => {
  assert.ok(Math.abs(ratio('#000000', '#ffffff') - 21) < 0.01)
})

test('existing themes all pass', () => {
  for (const name of ['default', 'japan']) {
    const r = checkTokens(mergedTokens(name))
    assert.equal(r.pass, true, `${name}: ${JSON.stringify(r.failures)}`)
  }
})

test('gold-on-paper style failure is caught', () => {
  const bad = { ...mergedTokens('default'), 'rail-deep': '#f3c95f' } // light gold as paper text
  const r = checkTokens(bad)
  assert.equal(r.pass, false)
  assert.ok(r.failures.some((f) => f.label.includes('rail-deep')))
})

test('validateOverrides rejects bad hex, unknown keys', () => {
  const allowed = ['rail', 'night']
  assert.equal(validateOverrides({ rail: '#0b7d6e' }, allowed).ok, true)
  assert.equal(validateOverrides({ rail: 'red' }, allowed).ok, false)
  assert.equal(validateOverrides({ rail: '#0b7d6e; } body{display:none' }, allowed).ok, false)
  assert.equal(validateOverrides({ paper: '#000000' }, allowed).ok, false) // not in allowlist
})
