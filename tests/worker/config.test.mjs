import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handleConfig } from '../../worker/routes/config.mjs'

test('handleConfig: returns turnstile_site_key when set', async () => {
  const res = await handleConfig(new Request('https://example.com/api/config'), { TURNSTILE_SITE_KEY: '0x123' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.turnstile_site_key, '0x123')
})

test('handleConfig: returns null when TURNSTILE_SITE_KEY is unset', async () => {
  const res = await handleConfig(new Request('https://example.com/api/config'), {})
  const body = await res.json()
  assert.equal(body.turnstile_site_key, null)
})
