import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDesignChoice } from '../pipeline/trip.mjs'

const OPTS = { presets: [{ name: 'japan' }, { name: 'default' }], custom: { enabled: true } }

test('preset name → preset choice', () => {
  assert.deepEqual(parseDesignChoice('japan', OPTS), { kind: 'preset', name: 'japan' })
})
test('custom:style → custom choice', () => {
  assert.deepEqual(parseDesignChoice('custom:深藍配金', OPTS), { kind: 'custom', style: '深藍配金' })
})
test('unknown name → presets[0] (honest default)', () => {
  assert.deepEqual(parseDesignChoice('nope', OPTS), { kind: 'preset', name: 'japan' })
})
test('empty/undefined → presets[0]', () => {
  assert.deepEqual(parseDesignChoice(undefined, OPTS), { kind: 'preset', name: 'japan' })
})
